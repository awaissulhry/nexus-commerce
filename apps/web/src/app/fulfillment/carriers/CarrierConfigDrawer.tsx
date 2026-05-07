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
  isActive: boolean
  hasCredentials: boolean
  lastVerifiedAt?: string | null
  lastErrorAt?: string | null
  lastError?: string | null
  mode?: 'sandbox' | 'production'
}

interface Props {
  def: CarrierDef
  carrier: CarrierRow | null
  open: boolean
  onClose: () => void
  onChanged: () => void
}

type TabId = 'credentials' | 'services' | 'rules' | 'webhooks'

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

  const disconnect = async () => {
    const ok = await askConfirm({
      title: t('carriers.disconnect.title', { name: def.label }),
      description: t('carriers.disconnect.description'),
      confirmLabel: t('carriers.action.disconnect'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/carriers/${def.code}/disconnect`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error('Disconnect failed')
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
    }
    // Rules tab is available for any carrier the rules engine can
    // target (which is any with a real CarrierCode value).
    if (def.code !== 'MANUAL') {
      list.push({ id: 'rules', label: 'Rules' })
    }
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
          {activeTab === 'rules' && (
            <RulesTab carrierCode={def.code} />
          )}
          {activeTab === 'webhooks' && def.code === 'SENDCLOUD' && (
            <WebhooksTab />
          )}
        </div>
      </ModalBody>

      <ModalFooter className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {isConnected && (
            <Button variant="danger" size="sm" onClick={disconnect} disabled={busy}>
              {t('carriers.action.disconnect')}
            </Button>
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

  return (
    <div className="space-y-4">
      <div>
        <p className="text-base text-slate-700 dark:text-slate-300">
          Map (channel, marketplace) → carrier service. The print-label flow uses these mappings before falling back to the carrier's automatic pick.
        </p>
        {services.length === 0 && (
          <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
            No services available. Connect the carrier first to populate the picker.
          </p>
        )}
      </div>

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

// ── Webhooks tab ───────────────────────────────────────────────────
// Surfaces the Sendcloud webhook URL operators paste into Sendcloud's
// integration panel. Today the signing secret comes from
// NEXUS_SENDCLOUD_WEBHOOK_SECRET env var; the UI just displays the URL
// + a hint. Per-carrier secret rotation from the UI lands in a later
// commit alongside Carrier.webhookSecret persistence.
function WebhooksTab() {
  const [copied, setCopied] = useState(false)
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

      <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded p-3">
        <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
        <div>
          The signing secret is currently configured via the <code className="px-1 py-0.5 bg-amber-100 dark:bg-amber-900/40 rounded text-xs">NEXUS_SENDCLOUD_WEBHOOK_SECRET</code> environment variable. Per-carrier secret rotation from this drawer lands in a follow-up commit.
        </div>
      </div>
    </div>
  )
}
