'use client'

// CR.6 — Carrier configuration drawer.
//
// Replaces the in-card inline accordion form with a side-drawer
// modal that scales to multiple tabs as later commits add Services
// (CR.7), Defaults (CR.13), Performance (CR.15), Activity (later).
//
// Today's tabs:
//   • Credentials — connect / update / test / disconnect
//   • Webhooks    — Sendcloud webhook URL display + copy
//
// All tabs share a sticky footer with Save + Test buttons. Footer is
// always visible so operators don't need to scroll on smaller
// screens. Drawer-right placement (640px max) so the marketplace
// stays partially visible behind it for context.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Check, Lock, AlertCircle, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Tabs, type Tab } from '@/components/ui/Tabs'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'

type Field = {
  key: string
  labelKey: string
  password?: boolean
  type?: 'number'
}

export interface CarrierDef {
  code: string
  label: string
  description: string
  docsUrl: string | null
  fields: Field[]
}

export interface CarrierRow {
  id?: string
  isActive: boolean
  hasCredentials: boolean
  lastVerifiedAt?: string | null
  lastErrorAt?: string | null
  lastError?: string | null
  mode?: 'sandbox' | 'production'
  preferences?: {
    includeInRateShop?: boolean
    preferCheapest?: boolean
    preferFastest?: boolean
    requireSignature?: boolean
  } | null
}

interface Props {
  def: CarrierDef
  carrier: CarrierRow | null
  open: boolean
  onClose: () => void
  onChanged: () => void
}

type TabId = 'credentials' | 'services' | 'warehouses' | 'defaults' | 'rules' | 'pickups' | 'performance' | 'activity' | 'webhooks'

export function CarrierConfigDrawer({ def, carrier, open, onClose, onChanged }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const [activeTab, setActiveTab] = useState<TabId>('credentials')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const isConnected = !!carrier?.isActive

  // Reset transient state every time the drawer opens for a different
  // carrier — prevents leaking secrets between carrier drawers.
  useEffect(() => {
    if (open) {
      setActiveTab('credentials')
      setFields({})
      setDirty(false)
    }
  }, [open, def.code])

  // CR.8: silent auto-test when the drawer opens for an already-
  // connected carrier. Refreshes lastVerifiedAt + surfaces stale-
  // credential errors without operator action. Throttled by the
  // drawer-open lifecycle (only fires on open transition, not on
  // tab switches). Toast suppressed here — the persisted state
  // shows up in the header on next refresh; an explicit "Test"
  // click still surfaces a toast for confirmation.
  useEffect(() => {
    if (!open || !carrier?.isActive) return
    const ac = new AbortController()
    void fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/test`,
      { method: 'POST', signal: ac.signal },
    )
      .then((res) => res.ok ? res.json().catch(() => ({})) : null)
      .then((body) => {
        // Refresh the list so the marketplace card reflects the new
        // lastVerifiedAt / lastError. The test endpoint persists; we
        // just need the parent to re-fetch.
        if (body) onChanged()
      })
      .catch(() => { /* abort or network blip — silent */ })
    return () => ac.abort()
  }, [open, carrier?.isActive, def.code, onChanged])

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleClose = async () => {
    if (dirty) {
      // Mirror the confirm-before-close pattern from /products drawer.
      const ok = await askConfirm({
        title: 'Discard unsaved changes?',
        description: 'Your credential changes will be lost.',
        confirmLabel: 'Discard',
        tone: 'danger',
      })
      if (!ok) return
    }
    onClose()
  }

  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = {}
      for (const f of def.fields) {
        const v = fields[f.key]
        if (f.type === 'number') body[f.key] = v ? Number(v) : undefined
        else body[f.key] = v
      }
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/connect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Connect failed')
      }
      setDirty(false)
      setFields({})
      onChanged()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const testConnection = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/test`,
        { method: 'POST' },
      )
      const body = await res.json().catch(() => ({}))
      if (body.dryRun) {
        toast.success(t('carriers.test.dryRun'))
        return
      }
      if (body.ok) {
        toast.success(t('carriers.test.success', { username: body.username ?? '?' }))
      } else {
        toast.error(t('carriers.test.failed', { reason: body.error ?? body.reason ?? 'unknown' }))
      }
    } catch (e: any) {
      toast.error(t('carriers.test.failed', { reason: e?.message ?? 'unknown' }))
    } finally {
      setBusy(false)
    }
  }

  // CR.18: two-tier disconnect. Plain disconnect leaves service
  // mappings + pickup schedules + preferences intact so a reconnect
  // restores the operator's setup. Purge disconnect (held alt key)
  // sweeps everything for a clean slate. UI surfaces the purge option
  // through a separate "Purge" button later — for now the askConfirm
  // dialog mentions the difference + the soft path is the default.
  const disconnect = async (purge = false) => {
    const ok = await askConfirm({
      title: t('carriers.disconnect.title', { name: def.label }),
      description: purge
        ? 'Purge: also remove all service mappings + cancel pickups. Existing shipments preserved. This is destructive — only use when starting over.'
        : t('carriers.disconnect.description'),
      confirmLabel: purge ? 'Purge + disconnect' : t('carriers.action.disconnect'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/disconnect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ purge }),
        },
      )
      if (!res.ok) throw new Error('Disconnect failed')
      const body = await res.json().catch(() => ({}))
      if (purge && (body.mappings > 0 || body.pickupsCancelled > 0)) {
        toast.success(`Purged · ${body.mappings} mappings, ${body.pickupsCancelled} pickups cancelled`)
      }
      onChanged()
      onClose()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  // Tabs are gated by carrier code. Webhooks tab is Sendcloud-only;
  // Buy Shipping doesn't expose a webhook surface (Amazon pushes via
  // SP-API notifications, configured at the seller-account level
  // outside Nexus).
  const tabs: Tab[] = useMemo(() => {
    const list: Tab[] = [{ id: 'credentials', label: 'Credentials' }]
    if (def.code === 'SENDCLOUD') {
      list.push({ id: 'services', label: 'Services' })
      list.push({ id: 'warehouses', label: 'Warehouses' })
    }
    // Rules tab is available for any carrier the rules engine can
    // target (which is any with a real CarrierCode value).
    if (def.code !== 'MANUAL') {
      list.push({ id: 'defaults', label: 'Defaults' })
      list.push({ id: 'rules', label: 'Rules' })
    }
    if (def.code === 'SENDCLOUD') {
      list.push({ id: 'pickups', label: 'Pickups' })
    }
    list.push({ id: 'performance', label: 'Performance' })
    list.push({ id: 'activity', label: 'Activity' })
    if (def.code === 'SENDCLOUD') {
      list.push({ id: 'webhooks', label: 'Webhooks' })
    }
    return list
  }, [def.code])

  const headerStatus = isConnected ? (
    <Badge variant="success" size="sm">{t('carriers.status.connected')}</Badge>
  ) : (
    <Badge variant="default" size="sm">{t('carriers.status.notConnected')}</Badge>
  )

  return (
    <Modal
      open={open}
      onClose={handleClose}
      placement="drawer-right"
      size="xl"
      title={
        <div className="flex items-center gap-2 flex-wrap">
          <span>{def.label}</span>
          {headerStatus}
          {carrier?.mode === 'sandbox' && <Badge variant="default" size="sm">sandbox</Badge>}
          {carrier?.lastError && (
            <Badge variant="warning" size="sm">{t('carriers.status.error')}</Badge>
          )}
        </div>
      }
      description={
        <div className="space-y-1">
          <div>{def.description}</div>
          {carrier?.isActive && (carrier?.lastVerifiedAt || carrier?.lastError) && (
            <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
              {carrier?.lastVerifiedAt && !carrier?.lastError && (
                <span className="inline-flex items-center gap-1">
                  <Check size={11} className="text-emerald-500" />
                  {t('carriers.status.verified', { when: relTime(carrier.lastVerifiedAt) })}
                </span>
              )}
              {carrier?.lastError && (
                <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                  <AlertCircle size={11} />
                  {carrier.lastError}
                </span>
              )}
            </div>
          )}
        </div>
      }
      dismissOnBackdrop={!dirty}
    >
      <ModalBody className="px-0 py-0">
        <div className="px-6 pt-3">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onChange={(id) => setActiveTab(id as TabId)}
          />
        </div>

        <div className="px-6 py-5">
          {activeTab === 'credentials' && (
            <CredentialsTab
              def={def}
              fields={fields}
              onField={updateField}
            />
          )}
          {activeTab === 'services' && def.code === 'SENDCLOUD' && (
            <ServicesTab carrierCode={def.code} />
          )}
          {activeTab === 'warehouses' && def.code === 'SENDCLOUD' && (
            <WarehousesTab carrierCode={def.code} />
          )}
          {activeTab === 'defaults' && (
            <DefaultsTab
              carrierCode={def.code}
              initial={carrier?.preferences ?? null}
              onSaved={onChanged}
            />
          )}
          {activeTab === 'rules' && (
            <RulesTab carrierCode={def.code} />
          )}
          {activeTab === 'pickups' && def.code === 'SENDCLOUD' && (
            <PickupsTab carrierCode={def.code} />
          )}
          {activeTab === 'performance' && (
            <PerformanceTab carrierCode={def.code} />
          )}
          {activeTab === 'activity' && carrier?.id && (
            <ActivityTab carrierId={carrier.id} />
          )}
          {activeTab === 'activity' && !carrier?.id && (
            <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
              Activity log appears after the carrier is connected.
            </div>
          )}
          {activeTab === 'webhooks' && def.code === 'SENDCLOUD' && (
            <WebhooksTab />
          )}
        </div>
      </ModalBody>

      <ModalFooter className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isConnected && (
            <>
              <Button variant="danger" size="sm" onClick={() => disconnect(false)} disabled={busy}>
                {t('carriers.action.disconnect')}
              </Button>
              {/* CR.18: purge variant for clean-slate disconnects.
                  Hidden behind alt-click + a destructive label so it
                  isn't the default path. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => disconnect(true)}
                disabled={busy}
                title="Disconnect + purge service mappings and cancel pickups"
              >
                Purge
              </Button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isConnected && (
            <Button variant="secondary" size="sm" onClick={testConnection} disabled={busy}>
              {t('carriers.action.test')}
            </Button>
          )}
          {def.fields.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              loading={busy}
              icon={<Lock size={11} />}
              disabled={!dirty && isConnected}
              title={!dirty && isConnected ? 'No changes' : undefined}
            >
              {isConnected ? t('common.save') : t('carriers.action.connect')}
            </Button>
          )}
          {def.fields.length === 0 && !isConnected && (
            <Button variant="primary" size="sm" onClick={save} loading={busy}>
              {t('carriers.action.connect')}
            </Button>
          )}
        </div>
      </ModalFooter>
    </Modal>
  )
}

// ── Credentials tab ────────────────────────────────────────────────
function CredentialsTab({
  def, fields, onField,
}: {
  def: CarrierDef
  fields: Record<string, string>
  onField: (key: string, value: string) => void
}) {
  const { t } = useTranslations()

  if (def.fields.length === 0) {
    return (
      <div className="text-base text-slate-600 dark:text-slate-300 space-y-2">
        <p>{def.description}</p>
        {def.code === 'AMAZON_BUY_SHIPPING' && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Uses your existing Seller Central credentials (configured at /settings/connections).
            Set <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs">NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true</code> to flip from sandbox to production.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {def.fields.map((f) => (
        <div key={f.key}>
          <label
            htmlFor={`field-${f.key}`}
            className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block"
          >
            {t(f.labelKey)}
          </label>
          <input
            id={`field-${f.key}`}
            type={f.password ? 'password' : f.type === 'number' ? 'number' : 'text'}
            value={fields[f.key] ?? ''}
            onChange={(e) => onField(f.key, e.target.value)}
            className="h-9 w-full px-3 text-base font-mono border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      ))}
      {def.docsUrl && (
        <a
          href={def.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
        >
          {t('carriers.action.docs')} <ExternalLink size={10} />
        </a>
      )}
    </div>
  )
}

/** CR.8: compact relative-time formatter for status chips ("2h ago"). */
function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  return `${Math.floor(d / 30)}mo ago`
}

// ── Services tab ───────────────────────────────────────────────────
// Replaces the opaque defaultServiceMap JSON. Operator picks
// (channel, marketplace, warehouse?) → carrier service mapping. Saved
// rows feed resolveServiceMap on the print-label path.
//
// Today's UX: a list of existing mappings + an "Add mapping" form.
// The matrix view (rows = channel × marketplace, columns = service
// tier) lands in CR.7+ once we have enough channels live to make a
// matrix cleaner than a list. Today (Amazon-only with 2 marketplaces)
// the list is shorter to scan.
type Mapping = {
  id: string
  channel: string
  marketplace: string
  warehouseId: string | null
  tierOverride: string | null
  service: { name: string; externalId: string; carrierSubName?: string | null; tier?: string | null } | null
}

type Service = {
  externalId: string
  name: string
  carrier: string
  basePriceEur: number
}

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY'] as const
const COMMON_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'GB', 'US', 'GLOBAL']

function ServicesTab({ carrierCode }: { carrierCode: string }) {
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const [mappings, setMappings] = useState<Mapping[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({
    channel: 'AMAZON',
    marketplace: 'IT',
    serviceExternalId: '',
  })
  const [busy, setBusy] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [mRes, sRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/mappings`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/services`, { cache: 'no-store' }),
      ])
      if (mRes.ok) {
        const m = await mRes.json()
        setMappings(m.items ?? [])
      }
      if (sRes.ok) {
        const s = await sRes.json()
        setServices(s.items ?? [])
      } else {
        // Sendcloud not connected yet — services list will be empty.
        setServices([])
      }
    } finally {
      setLoading(false)
    }
  }, [carrierCode])

  useEffect(() => { fetchAll() }, [fetchAll])

  const save = async () => {
    const svc = services.find((s) => s.externalId === draft.serviceExternalId)
    if (!svc) {
      toast.error('Pick a service first')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/mappings`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: draft.channel,
            marketplace: draft.marketplace,
            service: {
              externalId: svc.externalId,
              name: svc.name,
              carrierSubName: svc.carrier,
            },
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Save failed')
      }
      setAdding(false)
      setDraft({ channel: 'AMAZON', marketplace: 'IT', serviceExternalId: '' })
      fetchAll()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    const ok = await askConfirm({
      title: 'Remove this mapping?',
      description: 'Future shipments matching this channel/marketplace will fall back to the carrier auto-pick.',
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/mappings/${id}`,
      { method: 'DELETE' },
    )
    if (res.ok) fetchAll()
    else toast.error('Delete failed')
  }

  if (loading) {
    return <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading…</div>
  }

  const refreshCatalog = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/services/sync`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error('Sync failed')
      const body = await res.json().catch(() => ({}))
      toast.success(
        `Synced ${body.servicesSynced ?? 0} services` +
          (body.servicesDeactivated > 0 ? ` · ${body.servicesDeactivated} deactivated` : ''),
      )
      await fetchAll()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-base text-slate-700 dark:text-slate-300 flex-1">
          Map (channel, marketplace) → carrier service. The print-label flow uses these mappings before falling back to the carrier's automatic pick.
        </p>
        <Button variant="ghost" size="sm" onClick={refreshCatalog} disabled={busy}>
          Refresh catalog
        </Button>
      </div>
      {services.length === 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-300">
          No services available. Connect the carrier first or click Refresh catalog.
        </p>
      )}

      {/* Existing mappings */}
      {mappings.length === 0 ? (
        <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
          No mappings yet. Add one below.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Channel</th>
                <th className="text-left px-3 py-2 font-semibold">Marketplace</th>
                <th className="text-left px-3 py-2 font-semibold">Service</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {mappings.map((m) => (
                <tr key={m.id} className="text-slate-800 dark:text-slate-100">
                  <td className="px-3 py-2 font-medium">{m.channel}</td>
                  <td className="px-3 py-2">{m.marketplace}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{m.service?.name ?? '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {m.service?.carrierSubName} · id {m.service?.externalId}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => remove(m.id)}
                      className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400"
                      aria-label="Remove mapping"
                    >
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add new mapping */}
      {adding ? (
        <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 rounded">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Channel</label>
              <select
                value={draft.channel}
                onChange={(e) => setDraft({ ...draft, channel: e.target.value })}
                className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
              >
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Marketplace</label>
              <select
                value={draft.marketplace}
                onChange={(e) => setDraft({ ...draft, marketplace: e.target.value })}
                className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
              >
                {COMMON_MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Service</label>
              <select
                value={draft.serviceExternalId}
                onChange={(e) => setDraft({ ...draft, serviceExternalId: e.target.value })}
                className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
              >
                <option value="">— pick —</option>
                {services.map((s) => (
                  <option key={s.externalId} value={s.externalId}>
                    {s.name} ({s.carrier}, €{s.basePriceEur})
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={save} loading={busy}>Save mapping</Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus size={11} />}
          onClick={() => setAdding(true)}
          disabled={services.length === 0}
        >
          Add mapping
        </Button>
      )}
    </div>
  )
}

// ── Warehouses tab ─────────────────────────────────────────────────
// CR.11: bind each Warehouse to a Sendcloud sender_address ID. The
// print-label flow passes sender_address per shipment so multi-
// warehouse operators ship from the right origin (pre-CR.11 always
// used the Sendcloud integration default — wrong if it points at a
// different warehouse).
type Warehouse = {
  id: string
  code: string
  name: string
  city: string | null
  country: string
  isDefault: boolean
  isActive: boolean
  sendcloudSenderId: number | null
}

type SenderAddress = {
  id: number
  contactName: string
  companyName: string | null
  street: string
  city: string
  postalCode: string
  country: string
  isDefault: boolean
}

function WarehousesTab({ carrierCode }: { carrierCode: string }) {
  const { toast } = useToast()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [senders, setSenders] = useState<SenderAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [wRes, sRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/warehouses`, { cache: 'no-store' }),
        fetch(
          `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/sender-addresses`,
          { cache: 'no-store' },
        ),
      ])
      if (wRes.ok) {
        const w = await wRes.json()
        setWarehouses(w.items ?? [])
      }
      if (sRes.ok) {
        const s = await sRes.json()
        setSenders(s.items ?? [])
      } else {
        setSenders([])
      }
    } finally {
      setLoading(false)
    }
  }, [carrierCode])

  useEffect(() => { fetchAll() }, [fetchAll])

  const setSender = async (warehouseId: string, senderId: number | null) => {
    setBusyId(warehouseId)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/warehouses/${warehouseId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sendcloudSenderId: senderId }),
        },
      )
      if (!res.ok) throw new Error('Save failed')
      await fetchAll()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading…</div>
  }

  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700 dark:text-slate-300">
        Bind each warehouse to a Sendcloud sender address. The print-label flow uses this binding so multi-warehouse operators ship from the right origin. Warehouses with no binding fall back to the Sendcloud integration default.
      </p>

      {senders.length === 0 && (
        <div className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
          No sender addresses available. Connect Sendcloud first, then add a sender address in panel.sendcloud.sc → Settings → Addresses.
        </div>
      )}

      {warehouses.length === 0 ? (
        <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
          No warehouses configured. Add one at /fulfillment/stock first.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Warehouse</th>
                <th className="text-left px-3 py-2 font-semibold">Sendcloud sender</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {warehouses.map((w) => (
                <tr key={w.id} className="text-slate-800 dark:text-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">{w.code}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {w.name}{w.city ? ` · ${w.city}` : ''}{w.isDefault && ' · default'}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={w.sendcloudSenderId ?? ''}
                      disabled={busyId === w.id || senders.length === 0}
                      onChange={(e) =>
                        setSender(w.id, e.target.value === '' ? null : Number(e.target.value))
                      }
                      className="h-8 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
                    >
                      <option value="">— integration default —</option>
                      {senders.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.contactName} · {s.city} {s.postalCode}
                          {s.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Defaults tab ───────────────────────────────────────────────────
// CR.13: operator-tunable preferences. Persists to Carrier.preferences
// JSONB via PATCH /carriers/:code/preferences (merge semantics).
type Preferences = {
  includeInRateShop?: boolean
  preferCheapest?: boolean
  preferFastest?: boolean
  requireSignature?: boolean
}

function DefaultsTab({
  carrierCode, initial, onSaved,
}: {
  carrierCode: string
  initial: Preferences | null
  onSaved: () => void
}) {
  const { toast } = useToast()
  // includeInRateShop defaults to true when unset — operator opts OUT.
  const [prefs, setPrefs] = useState<Preferences>(() => ({
    includeInRateShop: initial?.includeInRateShop ?? true,
    preferCheapest: initial?.preferCheapest ?? true,
    preferFastest: initial?.preferFastest ?? false,
    requireSignature: initial?.requireSignature ?? false,
  }))
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => {
    setPrefs((p) => {
      const next = { ...p, [k]: v }
      // Mutually exclusive: preferFastest true → preferCheapest false.
      if (k === 'preferFastest' && v === true) next.preferCheapest = false
      if (k === 'preferCheapest' && v === true) next.preferFastest = false
      return next
    })
    setDirty(true)
  }

  const save = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/preferences`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(prefs),
        },
      )
      if (!res.ok) throw new Error('Save failed')
      setDirty(false)
      onSaved()
      toast.success('Preferences saved')
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700 dark:text-slate-300">
        These preferences shape how the rates endpoint and rules engine treat this carrier.
      </p>

      <div className="space-y-3">
        <Toggle
          label="Include in rate-shop"
          hint="When off, /shipments/:id/rates skips this carrier entirely."
          checked={!!prefs.includeInRateShop}
          onChange={(v) => set('includeInRateShop', v)}
        />
        <Toggle
          label="Prefer cheapest"
          hint="Auto-pick the cheapest eligible service when both Sendcloud and Buy Shipping are connected. Default."
          checked={!!prefs.preferCheapest}
          onChange={(v) => set('preferCheapest', v)}
        />
        <Toggle
          label="Prefer fastest"
          hint="Override cheapest — pick the fastest service. Useful for premium / Prime SLA orders."
          checked={!!prefs.preferFastest}
          onChange={(v) => set('preferFastest', v)}
        />
        <Toggle
          label="Require signature on delivery"
          hint="Default-on signature for parcels routed to this carrier (rules engine can override per shipment)."
          checked={!!prefs.requireSignature}
          onChange={(v) => set('requireSignature', v)}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!dirty}>
          Save preferences
        </Button>
        {dirty && <span className="text-sm text-amber-600 dark:text-amber-400">Unsaved changes</span>}
      </div>
    </div>
  )
}

function Toggle({
  label, hint, checked, onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <span
        className={`relative inline-flex h-5 w-9 flex-shrink-0 mt-0.5 rounded-full transition-colors ${
          checked ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-600'
        }`}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </span>
      <span className="flex-1">
        <div className="text-base font-medium text-slate-900 dark:text-slate-100">{label}</div>
        {hint && <div className="text-sm text-slate-500 dark:text-slate-400">{hint}</div>}
      </span>
    </label>
  )
}

// ── Rules tab ──────────────────────────────────────────────────────
// CR.14: surfaces ShippingRule rows whose actions.preferCarrierCode
// targets this carrier. Lets operators jump from "what does this
// carrier do" to "what rules drive shipments to it" without leaving
// the drawer. Lists name, priority, lastFiredAt, triggerCount; full
// edit happens at /fulfillment/outbound/rules.
type ShippingRule = {
  id: string
  name: string
  description: string | null
  priority: number
  isActive: boolean
  conditions: any
  actions: { preferCarrierCode?: string; preferServiceCode?: string }
  lastFiredAt: string | null
  triggerCount: number
}

function RulesTab({ carrierCode }: { carrierCode: string }) {
  const [rules, setRules] = useState<ShippingRule[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let abort = false
    fetch(`${getBackendUrl()}/api/fulfillment/shipping-rules`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((d) => { if (!abort) setRules(d.items ?? []) })
      .catch(() => { /* */ })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [])

  const matching = useMemo(
    () => rules.filter((r) => r.actions?.preferCarrierCode === carrierCode),
    [rules, carrierCode],
  )
  const matchingActive = matching.filter((r) => r.isActive)

  if (loading) {
    return <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading rules…</div>
  }

  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700 dark:text-slate-300">
        Shipping rules route shipments to this carrier when their conditions match. {matching.length === 0 ? 'No rules target this carrier yet.' : `${matchingActive.length} active of ${matching.length} total target this carrier.`}
      </p>

      {matching.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Name</th>
                <th className="text-left px-3 py-2 font-semibold w-16">Priority</th>
                <th className="text-left px-3 py-2 font-semibold w-20">Status</th>
                <th className="text-left px-3 py-2 font-semibold w-24">Triggers</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {matching.map((r) => (
                <tr key={r.id} className="text-slate-800 dark:text-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.name}</div>
                    {r.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">{r.description}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-sm">{r.priority}</td>
                  <td className="px-3 py-2">
                    {r.isActive
                      ? <Badge variant="success" size="sm">Active</Badge>
                      : <Badge variant="default" size="sm">Off</Badge>}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-600 dark:text-slate-300">
                    {r.triggerCount} {r.lastFiredAt && (<span className="text-xs text-slate-400">· last {relTime(r.lastFiredAt)}</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2">
        <a
          href={`/fulfillment/outbound/rules${matching.length > 0 ? '' : `?carrierCode=${carrierCode}`}`}
          className="inline-flex items-center gap-1 px-3 h-8 bg-blue-600 hover:bg-blue-700 text-white text-base rounded"
        >
          <Plus size={11} /> {matching.length > 0 ? 'Manage rules' : 'Add rule'}
        </a>
        <a
          href="/fulfillment/outbound/rules"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
        >
          Open rules workspace <ExternalLink size={10} />
        </a>
      </div>
    </div>
  )
}

// ── Performance tab ────────────────────────────────────────────────
// CR.15: per-carrier metrics (volume, cost, on-time, delivery time)
// over a selectable window. Live aggregation from Shipment +
// TrackingEvent today; the metrics-cron (later commit) will pre-warm
// the CarrierMetric table from CR.3 to absorb the read load when
// volume grows.
type Metrics = {
  carrierCode: string
  windowDays: number
  shipmentCount: number
  totalCostCents: number
  avgCostCents: number | null
  onTimeCount: number
  lateCount: number
  lateRate: number | null
  deliveredCount: number
  avgDeliveryHours: number | null
  byMarketplace: Array<{ marketplace: string; count: number }>
}

const WINDOWS = [7, 30, 90, 365] as const

function PerformanceTab({ carrierCode }: { carrierCode: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [windowDays, setWindowDays] = useState<number>(30)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let abort = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/metrics?windowDays=${windowDays}`,
      { cache: 'no-store' },
    )
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!abort) setMetrics(d) })
      .catch(() => { /* */ })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [carrierCode, windowDays])

  return (
    <div className="space-y-4">
      {/* Window selector */}
      <div className="inline-flex rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => setWindowDays(w)}
            className={`px-3 h-8 text-base border-r last:border-r-0 border-slate-200 dark:border-slate-700 ${
              windowDays === w
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-semibold'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            aria-pressed={windowDays === w}
          >
            {w}d
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading metrics…</div>
      ) : !metrics ? (
        <div className="text-base text-slate-500 dark:text-slate-400 py-2">No data.</div>
      ) : metrics.shipmentCount === 0 ? (
        <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
          No shipments in the last {metrics.windowDays} days.
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Kpi label="Shipments" value={metrics.shipmentCount.toLocaleString()} />
            <Kpi
              label="Avg cost"
              value={metrics.avgCostCents != null ? `€${(metrics.avgCostCents / 100).toFixed(2)}` : '—'}
            />
            <Kpi
              label="On-time"
              value={metrics.lateRate != null ? `${((1 - metrics.lateRate) * 100).toFixed(0)}%` : '—'}
              hint={metrics.onTimeCount + metrics.lateCount > 0 ? `${metrics.onTimeCount} of ${metrics.onTimeCount + metrics.lateCount}` : undefined}
            />
            <Kpi
              label="Avg delivery"
              value={metrics.avgDeliveryHours != null ? `${(metrics.avgDeliveryHours / 24).toFixed(1)}d` : '—'}
              hint={metrics.deliveredCount > 0 ? `${metrics.deliveredCount} delivered` : undefined}
            />
          </div>

          {/* Total cost */}
          <div className="text-sm text-slate-600 dark:text-slate-300">
            Total spend: <span className="font-semibold text-slate-900 dark:text-slate-100">€{(metrics.totalCostCents / 100).toFixed(2)}</span>
          </div>

          {/* By marketplace */}
          {metrics.byMarketplace.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">By marketplace</div>
              <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
                <table className="w-full text-base">
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {metrics.byMarketplace.map((row) => (
                      <tr key={row.marketplace} className="text-slate-800 dark:text-slate-100">
                        <td className="px-3 py-1.5">{row.marketplace}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-sm">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <a
            href="/fulfillment/outbound/analytics"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
          >
            Open full outbound analytics <ExternalLink size={10} />
          </a>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{label}</div>
      <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 mt-0.5">{value}</div>
      {hint && <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  )
}

// ── Activity tab ───────────────────────────────────────────────────
// CR.19: surfaces AuditLog entries scoped to this carrier. Connect /
// disconnect / test-connection events get audit-logged from the
// route handlers; this tab queries /api/audit-log/search filtered to
// entityType=Carrier + entityId={carrier.id}. Read-only.
type AuditEntry = {
  id: string
  userId: string | null
  entityType: string
  entityId: string
  action: string
  before: any
  after: any
  metadata: any
  createdAt: string
}

function ActivityTab({ carrierId }: { carrierId: string }) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let abort = false
    setLoading(true)
    fetch(
      `${getBackendUrl()}/api/audit-log/search?entityType=Carrier&entityId=${encodeURIComponent(carrierId)}&limit=50`,
      { cache: 'no-store' },
    )
      .then((r) => r.ok ? r.json() : { items: [] })
      .then((d) => { if (!abort) setEntries(d.items ?? []) })
      .catch(() => { /* */ })
      .finally(() => { if (!abort) setLoading(false) })
    return () => { abort = true }
  }, [carrierId])

  if (loading) {
    return <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading activity…</div>
  }
  if (entries.length === 0) {
    return (
      <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
        No activity yet. Connect / test / configure events appear here as they happen.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-base text-slate-700 dark:text-slate-300">
        Last 50 audit-log events for this carrier. Full log at{' '}
        <a href="/audit-log" className="text-blue-600 dark:text-blue-400 hover:underline">
          /audit-log
        </a>.
      </p>
      <ol className="space-y-1">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex items-start gap-2 px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded text-sm"
          >
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400 flex-shrink-0 w-32">
              {new Date(e.createdAt).toLocaleString()}
            </span>
            <span className="flex-1 min-w-0">
              <span className="font-semibold text-slate-900 dark:text-slate-100">{e.action}</span>
              {e.metadata?.dryRun && (
                <Badge variant="default" size="sm" >dryRun</Badge>
              )}
              {e.metadata?.purged && (
                <Badge variant="warning" size="sm" >purged</Badge>
              )}
              <span className="ml-2 text-slate-500 dark:text-slate-400 break-words">
                {summarizeAuditEntry(e)}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function summarizeAuditEntry(e: AuditEntry): string {
  // Tight one-liner per common action so the timeline reads cleanly.
  switch (e.action) {
    case 'create':
      return `Connected · ${e.metadata?.fieldsSupplied?.length ?? 0} fields`
    case 'update':
      return `Credentials updated · ${e.metadata?.fieldsSupplied?.length ?? 0} fields`
    case 'disconnect':
      return e.metadata?.purged
        ? `Disconnected + purged ${e.metadata?.mappings ?? 0} mappings, ${e.metadata?.pickupsCancelled ?? 0} pickups`
        : 'Disconnected (soft)'
    case 'test-connection':
      return e.after?.ok
        ? `Verified · ${e.after.username ?? '?'}`
        : `Test failed · ${e.after?.reason ?? 'unknown'}`
    default:
      return e.action
  }
}

// ── Pickups tab ────────────────────────────────────────────────────
// CR.16: PickupSchedule rows. List active + cancelled bookings; let
// operator request a new one-time pickup (recurring lands when the
// dispatch cron ships). One-time SENDCLOUD bookings hit Sendcloud
// /pickups inline so the operator sees the externalRef in the round-
// trip confirmation.
type Pickup = {
  id: string
  warehouseId: string | null
  isRecurring: boolean
  daysOfWeek: number | null
  scheduledFor: string | null
  windowStart: string | null
  windowEnd: string | null
  contactName: string | null
  contactPhone: string | null
  notes: string | null
  externalRef: string | null
  status: string
  lastDispatchAt: string | null
  lastDispatchErr: string | null
  createdAt: string
}

function PickupsTab({ carrierCode }: { carrierCode: string }) {
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const [pickups, setPickups] = useState<Pickup[]>([])
  const [warehouses, setWarehouses] = useState<Array<{ id: string; code: string; name: string; isDefault: boolean }>>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  // Default scheduledFor = tomorrow (today already booked-up at most carriers).
  const tomorrow = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }, [])
  const [draft, setDraft] = useState({
    warehouseId: '',
    scheduledFor: tomorrow,
    notes: '',
  })

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [pRes, wRes] = await Promise.all([
        fetch(`${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/pickups`, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/fulfillment/warehouses`, { cache: 'no-store' }),
      ])
      if (pRes.ok) setPickups((await pRes.json()).items ?? [])
      if (wRes.ok) {
        const w = await wRes.json()
        setWarehouses(w.items ?? [])
        // Auto-pick default warehouse on first render.
        const def = (w.items ?? []).find((x: any) => x.isDefault) ?? (w.items ?? [])[0]
        if (def && !draft.warehouseId) {
          setDraft((prev) => ({ ...prev, warehouseId: def.id }))
        }
      }
    } finally {
      setLoading(false)
    }
  // draft.warehouseId intentionally omitted — only seed once on initial load.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carrierCode])

  useEffect(() => { fetchAll() }, [fetchAll])

  const requestPickup = async () => {
    if (!draft.scheduledFor) {
      toast.error('Pick a date')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/pickups`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            warehouseId: draft.warehouseId || null,
            scheduledFor: new Date(draft.scheduledFor).toISOString(),
            notes: draft.notes || null,
            isRecurring: false,
          }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Pickup request failed')
      }
      const body = await res.json().catch(() => ({}))
      if (body.pickup?.lastDispatchErr) {
        toast.error(`Carrier rejected: ${body.pickup.lastDispatchErr}`)
      } else if (body.pickup?.externalRef) {
        toast.success(`Pickup scheduled · ${body.pickup.externalRef}`)
      } else {
        toast.success('Pickup scheduled')
      }
      setAdding(false)
      setDraft({ warehouseId: draft.warehouseId, scheduledFor: tomorrow, notes: '' })
      fetchAll()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (id: string) => {
    const ok = await askConfirm({
      title: 'Cancel this pickup?',
      description: 'Sendcloud may still hold the slot until the day passes — this just stops Nexus from re-dispatching.',
      confirmLabel: 'Cancel pickup',
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(
      `${getBackendUrl()}/api/fulfillment/carriers/${carrierCode}/pickups/${id}/cancel`,
      { method: 'POST' },
    )
    if (res.ok) fetchAll()
    else toast.error('Cancel failed')
  }

  if (loading) {
    return <div className="text-base text-slate-500 dark:text-slate-400 py-2">Loading…</div>
  }

  const activePickups = pickups.filter((p) => p.status === 'ACTIVE')
  const archivedPickups = pickups.filter((p) => p.status !== 'ACTIVE')

  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700 dark:text-slate-300">
        Schedule a pickup with Sendcloud. One-time bookings dispatch inline; the carrier confirmation reference appears below.
      </p>

      {/* Active pickups */}
      {activePickups.length === 0 ? (
        <div className="text-base text-slate-500 dark:text-slate-400 italic py-2">
          No active pickups.
        </div>
      ) : (
        <div className="border border-slate-200 dark:border-slate-700 rounded overflow-hidden">
          <table className="w-full text-base">
            <thead className="bg-slate-50 dark:bg-slate-800 text-xs uppercase tracking-wider text-slate-600 dark:text-slate-300">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Date</th>
                <th className="text-left px-3 py-2 font-semibold">Warehouse</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Ref</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {activePickups.map((p) => {
                const wh = warehouses.find((w) => w.id === p.warehouseId)
                return (
                  <tr key={p.id} className="text-slate-800 dark:text-slate-100">
                    <td className="px-3 py-2 font-mono text-sm">
                      {p.scheduledFor ? new Date(p.scheduledFor).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2">{wh?.code ?? '—'}</td>
                    <td className="px-3 py-2">
                      {p.lastDispatchErr
                        ? <Badge variant="warning" size="sm">Failed</Badge>
                        : p.externalRef
                        ? <Badge variant="success" size="sm">Confirmed</Badge>
                        : <Badge variant="default" size="sm">Pending</Badge>}
                    </td>
                    <td className="px-3 py-2 text-sm font-mono text-slate-500 dark:text-slate-400">
                      {p.externalRef ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => cancel(p.id)}
                        className="p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-900/30 text-rose-600 dark:text-rose-400"
                        aria-label="Cancel pickup"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add new */}
      {adding ? (
        <div className="space-y-2 p-3 border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 rounded">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Warehouse</label>
              <select
                value={draft.warehouseId}
                onChange={(e) => setDraft({ ...draft, warehouseId: e.target.value })}
                className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
              >
                <option value="">— integration default —</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.code} — {w.name}{w.isDefault ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Date</label>
              <input
                type="date"
                value={draft.scheduledFor}
                onChange={(e) => setDraft({ ...draft, scheduledFor: e.target.value })}
                className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
              />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-0.5 block">Notes</label>
            <input
              type="text"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="Driver instructions, gate code, etc."
              className="h-9 w-full px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 dark:text-slate-100 rounded"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={requestPickup} loading={busy}>Request pickup</Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button variant="secondary" size="sm" icon={<Plus size={11} />} onClick={() => setAdding(true)}>
          Schedule pickup
        </Button>
      )}

      {/* Archive */}
      {archivedPickups.length > 0 && (
        <details className="text-sm text-slate-500 dark:text-slate-400">
          <summary className="cursor-pointer">Archived ({archivedPickups.length})</summary>
          <ul className="mt-2 space-y-1 ml-4 list-disc">
            {archivedPickups.slice(0, 10).map((p) => (
              <li key={p.id}>
                {p.scheduledFor ? new Date(p.scheduledFor).toLocaleDateString() : '—'} · {p.status}
                {p.externalRef ? ` · ${p.externalRef}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

// ── Webhooks tab ───────────────────────────────────────────────────
// Surfaces the Sendcloud webhook URL operators paste into Sendcloud's
// integration panel. Today the signing secret comes from
// NEXUS_SENDCLOUD_WEBHOOK_SECRET env var; the UI just displays the URL
// + a hint. Per-carrier secret rotation from the UI lands in a later
// commit alongside Carrier.webhookSecret persistence.
function WebhooksTab() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [copied, setCopied] = useState(false)
  const [secretCopied, setSecretCopied] = useState(false)
  const [rotating, setRotating] = useState(false)
  // CR.20: hold the freshly-rotated plaintext secret in component
  // state for the operator to paste into Sendcloud's panel. Cleared
  // when the drawer closes — never re-fetchable from the backend.
  const [freshSecret, setFreshSecret] = useState<string | null>(null)
  const url = useMemo(() => `${getBackendUrl()}/api/webhooks/sendcloud`, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — operator pastes manually */
    }
  }

  const copySecret = async () => {
    if (!freshSecret) return
    try {
      await navigator.clipboard.writeText(freshSecret)
      setSecretCopied(true)
      setTimeout(() => setSecretCopied(false), 1500)
    } catch { /* */ }
  }

  const rotate = async () => {
    const ok = await askConfirm({
      title: 'Rotate webhook secret?',
      description: 'Sendcloud will reject events signed with the old secret immediately. You must paste the new secret into Sendcloud panel right after rotating, or webhooks will fail.',
      confirmLabel: 'Rotate',
      tone: 'danger',
    })
    if (!ok) return
    setRotating(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/SENDCLOUD/webhook-secret/rotate`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error('Rotation failed')
      const body = await res.json().catch(() => ({}))
      if (body.secret) {
        setFreshSecret(body.secret)
        toast.success('Secret rotated — paste into Sendcloud panel now.')
      }
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setRotating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-1">
          Webhook URL
        </div>
        <div className="flex items-stretch gap-1">
          <code className="flex-1 px-3 py-2 text-sm font-mono bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded text-slate-800 dark:text-slate-100 break-all">
            {url}
          </code>
          <Button variant="secondary" size="sm" onClick={copy} icon={copied ? <Check size={11} /> : <Copy size={11} />}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Paste this URL into Sendcloud → Settings → Integrations → Webhooks. Send all parcel-status events; signature header is <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs">Sendcloud-Signature</code>.
        </p>
      </div>

      {/* CR.20: rotation surface */}
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
          Signing secret
        </div>
        {freshSecret ? (
          <div className="space-y-2">
            <div className="text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded p-3">
              <div className="font-semibold mb-1">New secret — copy now, it won't be shown again.</div>
              <div className="flex items-stretch gap-1">
                <code className="flex-1 px-2 py-1 text-xs font-mono bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 rounded break-all select-all">
                  {freshSecret}
                </code>
                <Button variant="secondary" size="sm" onClick={copySecret} icon={secretCopied ? <Check size={11} /> : <Copy size={11} />}>
                  {secretCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setFreshSecret(null)}>
              Done — hide secret
            </Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Falls back to the <code className="px-1 py-0.5 bg-slate-100 dark:bg-slate-800 rounded text-xs">NEXUS_SENDCLOUD_WEBHOOK_SECRET</code> env var when no per-carrier secret is set. Rotating generates a new 256-bit secret, persists it encrypted, and returns the plaintext once for you to paste into Sendcloud.
            </p>
            <Button variant="secondary" size="sm" onClick={rotate} loading={rotating}>
              Rotate webhook secret
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
