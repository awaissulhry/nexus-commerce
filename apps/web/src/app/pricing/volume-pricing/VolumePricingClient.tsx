'use client'

/**
 * VP.5 — eBay Volume Pricing management UI.
 *
 * The user-facing surface for the VP.0–VP.3 backend
 * (apps/api/src/routes/ebay-volume-pricing.routes.ts). Built ENTIRELY from the
 * H10 design system — every component comes from @/design-system/{components,
 * primitives}; every layout colour/border is an inline `var(--h10-*)` token (no
 * raw Tailwind colour/border classes, which the P3 guard bans outside
 * flat-file/design paths).
 *
 *   List       — a DataGrid of EbayVolumePromotion rows + EmptyState + "New".
 *   Create/edit — a lg Modal with the tier-ladder editor, a live /preview margin
 *                 simulator (margin guard floor surfaced in --h10-danger), and
 *                 By-rule | Manual SKU selection (/resolve-skus).
 *   Row actions — edit, push (/:id/push, dry-run gated server-side), delete.
 *
 * eBay volume tiers are FIXED at buy-2 / buy-3 / buy-4 (1–3 tiers, strictly
 * increasing %), enforced by the backend's validateVolumeTiers — the editor
 * mirrors that shape so the operator can't build an invalid ladder by hand.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Layers,
  Plus,
  Pencil,
  Trash2,
  UploadCloud,
  RefreshCw,
  Search,
} from 'lucide-react'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Card } from '@/design-system/components/Card'
import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { Modal } from '@/design-system/components/Modal'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Banner } from '@/design-system/components/Banner'
import { Combobox, type ComboboxOption } from '@/design-system/components/Combobox'
import { ToastProvider, useToast } from '@/design-system/components/Toast'
import { DateField } from '@/design-system/components/DateField'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Textarea } from '@/design-system/primitives/Textarea'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Tag, type TagTone } from '@/design-system/primitives/Tag'
import { Pill } from '@/design-system/primitives/Pill'
import { type Tone } from '@/design-system/primitives/tone'
import { Spinner } from '@/design-system/primitives/Spinner'
import { Divider } from '@/design-system/primitives/Divider'
import { getBackendUrl } from '@/lib/backend-url'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

// ── Types (mirror the VP.0–VP.3 API payloads) ───────────────────────────────

type Marketplace = 'IT' | 'DE' | 'FR' | 'ES' | 'UK'
const MARKETPLACES: Marketplace[] = ['IT', 'DE', 'FR', 'ES', 'UK']

interface VolumeTier {
  minQty: number
  percentOff: number
}

interface VolumePromotion {
  id: string
  name: string
  marketplace: string
  tiers: VolumeTier[]
  skus: string[] | null
  status: string
  startDate: string | null
  endDate: string | null
  lastSyncAt?: string | null
  createdAt: string
  updatedAt: string
}

interface TierComputation {
  minQty: number
  percentOff: number
  unitPrice: number
  marginPercent: number | null
}

interface TierValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

interface PreviewResponse {
  validation: TierValidation
  computed: TierComputation[]
}

interface ResolvedSku {
  sku: string
  price: number
  marginPercent: number | null
}

interface ResolveSkusResult {
  skus: string[]
  count: number
  truncated: boolean
  matched: number
  sample: ResolvedSku[]
}

interface TierTemplate {
  id: string
  name: string
  description: string | null
  tiers: VolumeTier[]
}

interface PushResult {
  ok: boolean
  dryRun?: boolean
  error?: string
  warnings?: string[]
  message?: string
  detail?: string
}

// ── Status → Pill / Tag mapping ──────────────────────────────────────────────

const STATUS_PILL: Record<string, Tone> = {
  DRAFT: 'neutral',
  SCHEDULED: 'warning',
  ACTIVE: 'success',
  PUSHED: 'success',
  ENDED: 'neutral',
  FAILED: 'danger',
  ERROR: 'danger',
}

function statusPill(status: string): Tone {
  return STATUS_PILL[status.toUpperCase()] ?? 'neutral'
}

const MARKET_TONE: Record<string, TagTone> = {
  IT: 'success',
  DE: 'info',
  FR: 'info',
  ES: 'warning',
  UK: 'neutral',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const api = (path: string) => `${getBackendUrl()}/api${path}`

/** "2→5% · 3→10%" tier summary. */
function tierSummary(tiers: VolumeTier[]): string {
  if (!Array.isArray(tiers) || tiers.length === 0) return '—'
  return tiers
    .slice()
    .sort((a, b) => a.minQty - b.minQty)
    .map((t) => `${t.minQty}→${t.percentOff}%`)
    .join(' · ')
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const label = (children: ReactNode): ReactNode => (
  <span
    className="text-[12px]"
    style={{ fontWeight: 600, color: 'var(--h10-text-2)', display: 'block', marginBottom: 6 }}
  >
    {children}
  </span>
)

const muted = (size = 12): React.CSSProperties => ({ fontSize: size, color: 'var(--h10-text-3)' })

// The fixed eBay ladder: tier index i → minQty i+2 (buy-2, buy-3, buy-4).
const tierQtyForIndex = (i: number) => i + 2

// ── Root (provides the local Toast context the ads/pricing routes lack) ───────

export default function VolumePricingClient() {
  return (
    <ToastProvider>
      <VolumePricingInner />
    </ToastProvider>
  )
}

function VolumePricingInner() {
  const { toast } = useToast()
  const [promotions, setPromotions] = useState<VolumePromotion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<VolumePromotion | null>(null)

  const [confirmDelete, setConfirmDelete] = useState<VolumePromotion | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [pushingId, setPushingId] = useState<string | null>(null)

  // ── Load list ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(api('/ebay/volume-promotions'), { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { promotions: VolumePromotion[] }
      setPromotions(Array.isArray(data.promotions) ? data.promotions : [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load volume promotions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setEditorOpen(true)
  }
  const openEdit = (p: VolumePromotion) => {
    setEditing(p)
    setEditorOpen(true)
  }

  // ── Push ─────────────────────────────────────────────────────────────────────
  const pushPromotion = useCallback(
    async (p: VolumePromotion) => {
      setPushingId(p.id)
      try {
        const res = await fetch(api(`/ebay/volume-promotions/${p.id}/push`), { method: 'POST' })
        const data = (await res.json()) as PushResult
        if (!res.ok || !data.ok) {
          toast(data.error ?? data.message ?? 'Push failed', 'danger')
        } else if (data.dryRun) {
          toast(`Dry run OK — “${p.name}” validated, not sent live`, 'info')
        } else {
          toast(`Pushed “${p.name}” to eBay ${p.marketplace}`, 'success')
        }
        if (data.warnings?.length) {
          toast(`${data.warnings.length} warning(s): ${data.warnings[0]}`, 'info')
        }
        await load()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Push failed', 'danger')
      } finally {
        setPushingId(null)
      }
    },
    [toast, load],
  )

  // ── Delete ─────────────────────────────────────────────────────────────────
  const doDelete = useCallback(async () => {
    if (!confirmDelete) return
    setDeleting(true)
    try {
      const res = await fetch(api(`/ebay/volume-promotions/${confirmDelete.id}`), { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast(`Deleted “${confirmDelete.name}”`, 'success')
      setConfirmDelete(null)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'danger')
    } finally {
      setDeleting(false)
    }
  }, [confirmDelete, toast, load])

  // ── Columns ──────────────────────────────────────────────────────────────────
  const columns = useMemo<Column<VolumePromotion>[]>(
    () => [
      {
        key: 'name',
        label: 'Promotion',
        sortable: true,
        sortValue: (r) => r.name.toLowerCase(),
        render: (r) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600, color: 'var(--h10-text)' }}>{r.name}</span>
            <span style={muted(11)}>{fmtDate(r.startDate)} → {fmtDate(r.endDate)}</span>
          </div>
        ),
      },
      {
        key: 'marketplace',
        label: 'Market',
        align: 'center',
        sortable: true,
        sortValue: (r) => r.marketplace,
        render: (r) => <Tag tone={MARKET_TONE[r.marketplace] ?? 'neutral'}>{r.marketplace}</Tag>,
      },
      {
        key: 'status',
        label: 'Status',
        align: 'center',
        sortable: true,
        sortValue: (r) => r.status,
        render: (r) => <Pill tone={statusPill(r.status)}>{r.status}</Pill>,
      },
      {
        key: 'tiers',
        label: 'Tiers',
        render: (r) => (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--h10-text)' }}>
            {tierSummary(r.tiers)}
          </span>
        ),
      },
      {
        key: 'skus',
        label: 'SKUs',
        align: 'right',
        sortable: true,
        sortValue: (r) => (Array.isArray(r.skus) ? r.skus.length : 0),
        render: (r) => (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--h10-text-2)' }}>
            {Array.isArray(r.skus) ? r.skus.length : 0}
          </span>
        ),
      },
      {
        key: 'lastSync',
        label: 'Last sync',
        align: 'right',
        sortable: true,
        sortValue: (r) => (r.lastSyncAt ? new Date(r.lastSyncAt).getTime() : 0),
        render: (r) => <span style={muted()}>{fmtDate(r.lastSyncAt)}</span>,
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        render: (r) => (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" onClick={() => openEdit(r)} aria-label={`Edit ${r.name}`}>
              <Pencil size={13} /> Edit
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => pushPromotion(r)}
              disabled={pushingId === r.id}
              aria-label={`Push ${r.name} to eBay`}
            >
              {pushingId === r.id ? <Spinner size={13} /> : <UploadCloud size={13} />} Push
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfirmDelete(r)}
              aria-label={`Delete ${r.name}`}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ),
      },
    ],
    [pushingId, pushPromotion],
  )

  return (
    <div>
      <PageHeader
        eyebrow="eBay"
        title="Volume Pricing"
        subtitle="Multi-buy discount tiers (buy-2 / buy-3 / buy-4) pushed to eBay IT · DE · FR · ES · UK."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <Button variant="primary" onClick={openCreate}>
              <Plus size={14} /> New promotion
            </Button>
          </div>
        }
      />

      {loadError && (
        <div style={{ marginBottom: 12 }}>
          <Banner
            tone="danger"
            title="Couldn’t load volume promotions"
            action={
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                Retry
              </Button>
            }
          >
            {loadError}
          </Banner>
        </div>
      )}

      <Card>
        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: '48px 0',
              color: 'var(--h10-text-3)',
            }}
          >
            <Spinner size={18} /> Loading volume promotions…
          </div>
        ) : (
          <DataGrid
            columns={columns}
            rows={promotions}
            rowKey={(r) => r.id}
            initialSort={{ key: 'name', dir: 'asc' }}
            emptyState={
              <EmptyState
                icon={<Layers size={24} />}
                title="No volume promotions yet"
                description="Create a multi-buy discount ladder (buy-2 / buy-3 / buy-4) and push it to eBay."
                action={
                  <Button variant="primary" onClick={openCreate}>
                    <Plus size={14} /> New promotion
                  </Button>
                }
              />
            }
          />
        )}
      </Card>

      {editorOpen && (
        <PromotionEditor
          promotion={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            setEditorOpen(false)
            await load()
          }}
          onPushed={async () => {
            await load()
          }}
        />
      )}

      <Modal
        open={confirmDelete != null}
        onClose={() => (deleting ? undefined : setConfirmDelete(null))}
        title="Delete volume promotion"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void doDelete()} disabled={deleting}>
              {deleting ? <Spinner size={14} /> : <Trash2 size={14} />} Delete
            </Button>
          </>
        }
      >
        <div className="text-[14px]" style={{ color: 'var(--h10-text-2)' }}>
          Delete <strong style={{ color: 'var(--h10-text)' }}>{confirmDelete?.name}</strong>? This
          removes the promotion from Nexus. Tiers already pushed to eBay are not retracted by this
          action.
        </div>
      </Modal>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// Create / edit editor
// ════════════════════════════════════════════════════════════════════════════

type SkuMode = 'rule' | 'manual'

interface EditorProps {
  promotion: VolumePromotion | null
  onClose: () => void
  onSaved: () => Promise<void> | void
  onPushed: () => Promise<void> | void
}

function PromotionEditor({ promotion, onClose, onSaved, onPushed }: EditorProps) {
  const { toast } = useToast()
  const isEdit = promotion != null

  // ── Core fields ──────────────────────────────────────────────────────────────
  const [name, setName] = useState(promotion?.name ?? '')
  const [marketplace, setMarketplace] = useState<Marketplace>(
    (promotion?.marketplace as Marketplace) ?? 'IT',
  )
  const [startDate, setStartDate] = useState(promotion?.startDate ? promotion.startDate.slice(0, 10) : '')
  const [endDate, setEndDate] = useState(promotion?.endDate ? promotion.endDate.slice(0, 10) : '')

  // ── Tier ladder (1–3 rows; minQty derived from index = fixed eBay ladder) ────
  const [percents, setPercents] = useState<string[]>(() => {
    const sorted = (promotion?.tiers ?? []).slice().sort((a, b) => a.minQty - b.minQty)
    if (sorted.length === 0) return ['5']
    return sorted.map((t) => String(t.percentOff))
  })

  const tiers = useMemo<VolumeTier[]>(
    () =>
      percents.map((p, i) => ({
        minQty: tierQtyForIndex(i),
        percentOff: Number(p) || 0,
      })),
    [percents],
  )

  const addTier = () => {
    if (percents.length >= 3) return
    // seed strictly-increasing so the ladder stays valid by default
    const last = Number(percents[percents.length - 1]) || 0
    setPercents((p) => [...p, String(last + 5)])
  }
  const removeTier = (idx: number) => {
    if (percents.length <= 1) return
    setPercents((p) => p.filter((_, i) => i !== idx))
  }
  const setPercent = (idx: number, v: string) =>
    setPercents((p) => p.map((x, i) => (i === idx ? v : x)))

  // ── Templates (Load template → fills the ladder) ─────────────────────────────
  const [templates, setTemplates] = useState<TierTemplate[]>([])
  const [templateId, setTemplateId] = useState('')
  useEffect(() => {
    let cancelled = false
    fetch(api('/ebay/volume-tier-templates'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return
        setTemplates(Array.isArray(data.templates) ? data.templates : [])
      })
      .catch(() => {
        /* templates are optional — never block the editor */
      })
    return () => {
      cancelled = true
    }
  }, [])
  const templateOptions = useMemo<ComboboxOption[]>(
    () => templates.map((t) => ({ value: t.id, label: t.name })),
    [templates],
  )
  const applyTemplate = (id: string) => {
    setTemplateId(id)
    const tpl = templates.find((t) => t.id === id)
    if (!tpl) return
    const sorted = tpl.tiers.slice().sort((a, b) => a.minQty - b.minQty)
    setPercents(sorted.length ? sorted.map((t) => String(t.percentOff)) : ['5'])
    toast(`Loaded template “${tpl.name}”`, 'info')
  }

  // ── Margin simulator (/preview) ──────────────────────────────────────────────
  const [basePrice, setBasePrice] = useState('49.90')
  const [cost, setCost] = useState('')
  const [floorMargin, setFloorMargin] = useState('20')
  const [preview, setPreview] = useState<PreviewResponse | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const previewTimer = useRef<number | null>(null)

  // Debounced /preview whenever tiers / base price / cost change.
  useEffect(() => {
    const bp = Number(basePrice)
    if (!(bp > 0) || tiers.length === 0) {
      setPreview(null)
      return
    }
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current)
    previewTimer.current = window.setTimeout(async () => {
      setPreviewing(true)
      try {
        const costNum = cost.trim() === '' ? null : Number(cost)
        const res = await fetch(api('/ebay/volume-promotions/preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tiers, basePrice: bp, cost: costNum }),
        })
        if (!res.ok) {
          // 400 from preview still carries a validation body in some cases; try to read it
          const body = (await res.json().catch(() => null)) as PreviewResponse | null
          setPreview(body && body.validation ? body : null)
          return
        }
        setPreview((await res.json()) as PreviewResponse)
      } catch {
        setPreview(null)
      } finally {
        setPreviewing(false)
      }
    }, 350)
    return () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current)
    }
  }, [tiers, basePrice, cost])

  const floor = Number(floorMargin)
  const hasFloor = floorMargin.trim() !== '' && floor > 0

  // ── SKU selection ────────────────────────────────────────────────────────────
  const [skuMode, setSkuMode] = useState<SkuMode>(
    promotion?.skus && promotion.skus.length ? 'manual' : 'rule',
  )
  const [manualText, setManualText] = useState((promotion?.skus ?? []).join('\n'))

  // rule inputs
  const [ruleCategory, setRuleCategory] = useState('')
  const [ruleBrand, setRuleBrand] = useState('')
  const [ruleMinMargin, setRuleMinMargin] = useState('')
  const [ruleMaxPrice, setRuleMaxPrice] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState<ResolveSkusResult | null>(null)

  const manualSkus = useMemo(
    () =>
      manualText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [manualText],
  )

  const effectiveSkus = useMemo<string[]>(() => {
    if (skuMode === 'manual') return manualSkus
    return resolved?.skus ?? []
  }, [skuMode, manualSkus, resolved])

  const resolveSkus = useCallback(async () => {
    setResolving(true)
    setResolved(null)
    try {
      const res = await fetch(api('/ebay/volume-promotions/resolve-skus'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace,
          categoryId: ruleCategory.trim() || undefined,
          brand: ruleBrand.trim() || undefined,
          minMarginPercent: ruleMinMargin.trim() ? Number(ruleMinMargin) : undefined,
          maxPrice: ruleMaxPrice.trim() ? Number(ruleMaxPrice) : undefined,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast(body?.error ?? `Resolve failed (HTTP ${res.status})`, 'danger')
        return
      }
      const data = (await res.json()) as ResolveSkusResult
      setResolved(data)
      toast(`Matched ${data.matched} SKU(s) — ${data.count} selected`, 'info')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Resolve failed', 'danger')
    } finally {
      setResolving(false)
    }
  }, [marketplace, ruleCategory, ruleBrand, ruleMinMargin, ruleMaxPrice, toast])

  // ── Save / save-and-push ─────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false)

  const valid = preview?.validation ?? null
  const tiersOk = !valid || valid.ok
  const canSave = name.trim().length > 0 && tiers.length > 0 && tiersOk

  const buildBody = () => ({
    name: name.trim(),
    marketplace,
    tiers,
    skus: effectiveSkus,
    startDate: startDate || null,
    endDate: endDate || null,
  })

  /** Create or update; returns the row id (or null on failure). */
  const persist = useCallback(async (): Promise<string | null> => {
    const body = buildBody()
    try {
      if (isEdit && promotion) {
        const res = await fetch(api(`/ebay/volume-promotions/${promotion.id}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = (await res.json().catch(() => null)) as
          | { promotion?: VolumePromotion; error?: string; validation?: TierValidation }
          | null
        if (!res.ok) {
          toast(data?.validation?.errors?.[0] ?? data?.error ?? 'Save failed', 'danger')
          return null
        }
        return promotion.id
      }
      const res = await fetch(api('/ebay/volume-promotions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => null)) as
        | { promotion?: VolumePromotion; error?: string; validation?: TierValidation }
        | null
      if (!res.ok || !data?.promotion) {
        toast(data?.validation?.errors?.[0] ?? data?.error ?? 'Create failed', 'danger')
        return null
      }
      return data.promotion.id
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'danger')
      return null
    }
  }, [isEdit, promotion, name, marketplace, tiers, effectiveSkus, startDate, endDate, toast])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const id = await persist()
    setSaving(false)
    if (id) {
      toast(isEdit ? 'Saved' : 'Created as draft', 'success')
      await onSaved()
    }
  }, [persist, isEdit, toast, onSaved])

  const handleSaveAndPush = useCallback(async () => {
    setSaving(true)
    const id = await persist()
    if (!id) {
      setSaving(false)
      return
    }
    try {
      const res = await fetch(api(`/ebay/volume-promotions/${id}/push`), { method: 'POST' })
      const data = (await res.json()) as PushResult
      if (!res.ok || !data.ok) {
        toast(data.error ?? data.message ?? 'Push failed', 'danger')
      } else if (data.dryRun) {
        toast('Saved — dry run OK (not sent live)', 'info')
      } else {
        toast(`Saved & pushed to eBay ${marketplace}`, 'success')
      }
      if (data.warnings?.length) toast(`Warning: ${data.warnings[0]}`, 'info')
      await onPushed()
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Push failed', 'danger')
    } finally {
      setSaving(false)
    }
  }, [persist, marketplace, toast, onPushed, onClose])

  // ── Render ───────────────────────────────────────────────────────────────────

  const sectionTitle = (text: string): ReactNode => (
    <div className="text-[13px]" style={{ fontWeight: 700, color: 'var(--h10-text)', marginBottom: 10 }}>
      {text}
    </div>
  )

  return (
    <Modal
      open
      onClose={() => (saving ? undefined : onClose())}
      size="lg"
      title={isEdit ? 'Edit volume promotion' : 'New volume promotion'}
      subtitle="eBay multi-buy discount ladder · fixed buy-2 / buy-3 / buy-4 tiers"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void handleSave()} disabled={!canSave || saving}>
            {saving ? <Spinner size={14} /> : null} Save draft
          </Button>
          <Button variant="primary" onClick={() => void handleSaveAndPush()} disabled={!canSave || saving}>
            {saving ? <Spinner size={14} /> : <UploadCloud size={14} />} Push to eBay
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* ── Basics ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            {label('Promotion name')}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Spring multi-buy — gloves"
              fieldClassName="w-full"
            />
          </div>
          <div>
            {label('Marketplace')}
            <SegmentedControl
              options={MARKETPLACES.map((m) => ({ value: m, label: m }))}
              value={marketplace}
              onChange={(v) => setMarketplace(v as Marketplace)}
            />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            {label('Start date')}
            <DateField value={startDate} onChange={setStartDate} ariaLabel="Start date" className="w-full" />
          </div>
          <div>
            {label('End date')}
            <DateField value={endDate} onChange={setEndDate} ariaLabel="End date" className="w-full" />
          </div>
        </div>

        <Divider />

        {/* ── Tier ladder ─────────────────────────────────────────────────── */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            {sectionTitle('Discount tiers')}
            {templateOptions.length > 0 && (
              <div style={{ width: 240 }}>
                <Combobox
                  options={templateOptions}
                  value={templateId}
                  onChange={applyTemplate}
                  placeholder="Load template…"
                />
              </div>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {percents.map((p, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    minWidth: 84,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--h10-text-2)',
                  }}
                >
                  Buy {tierQtyForIndex(i)}+
                </div>
                <div style={{ width: 140 }}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={99}
                    step={1}
                    value={p}
                    onChange={(e) => setPercent(i, e.target.value)}
                    suffix="%"
                    aria-label={`Buy ${tierQtyForIndex(i)} discount percent`}
                  />
                </div>
                <span style={muted(12)}>off</span>
                <div style={{ flex: 1 }} />
                {percents.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeTier(i)}
                    aria-label={`Remove buy-${tierQtyForIndex(i)} tier`}
                  >
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
            ))}
          </div>

          {percents.length < 3 && (
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="ghost" onClick={addTier}>
                <Plus size={13} /> Add tier (buy {tierQtyForIndex(percents.length)})
              </Button>
            </div>
          )}

          <div style={{ marginTop: 8, ...muted(11) }}>
            eBay fixes the tiers at buy-2, buy-3, buy-4 with strictly-increasing discounts.
          </div>
        </div>

        {/* ── Validation banners ──────────────────────────────────────────── */}
        {valid && valid.errors.length > 0 && (
          <Banner tone="danger" title="Fix these before pushing">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {valid.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </Banner>
        )}
        {valid && valid.ok && valid.warnings.length > 0 && (
          <Banner tone="warning" title="Heads up">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {valid.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}

        <Divider />

        {/* ── Margin simulator ────────────────────────────────────────────── */}
        <div>
          {sectionTitle('Margin simulator')}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              {label('Sample base price')}
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                prefix="€"
                fieldClassName="w-full"
              />
            </div>
            <div>
              {label('Unit cost (optional)')}
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                prefix="€"
                placeholder="—"
                fieldClassName="w-full"
              />
            </div>
            <div>
              {label('Floor margin (guard)')}
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                max={99}
                step={1}
                value={floorMargin}
                onChange={(e) => setFloorMargin(e.target.value)}
                suffix="%"
                fieldClassName="w-full"
              />
            </div>
          </div>

          <MarginTable
            computed={preview?.computed ?? null}
            previewing={previewing}
            hasFloor={hasFloor}
            floor={floor}
            hasCost={cost.trim() !== ''}
          />
        </div>

        <Divider />

        {/* ── SKU selection ───────────────────────────────────────────────── */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            {sectionTitle('Apply to SKUs')}
            <SegmentedControl
              size="sm"
              options={[
                { value: 'rule', label: 'By rule' },
                { value: 'manual', label: 'Manual' },
              ]}
              value={skuMode}
              onChange={(v) => setSkuMode(v as SkuMode)}
            />
          </div>

          {skuMode === 'rule' ? (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  {label('Category ID')}
                  <Input
                    value={ruleCategory}
                    onChange={(e) => setRuleCategory(e.target.value)}
                    placeholder="optional — subtree root"
                    fieldClassName="w-full"
                  />
                </div>
                <div>
                  {label('Brand')}
                  <Input
                    value={ruleBrand}
                    onChange={(e) => setRuleBrand(e.target.value)}
                    placeholder="optional"
                    fieldClassName="w-full"
                  />
                </div>
                <div>
                  {label('Min margin %')}
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={99}
                    value={ruleMinMargin}
                    onChange={(e) => setRuleMinMargin(e.target.value)}
                    suffix="%"
                    placeholder="optional"
                    fieldClassName="w-full"
                  />
                </div>
                <div>
                  {label('Max price')}
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={ruleMaxPrice}
                    onChange={(e) => setRuleMaxPrice(e.target.value)}
                    prefix="€"
                    placeholder="optional"
                    fieldClassName="w-full"
                  />
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
                <Button variant="secondary" onClick={() => void resolveSkus()} disabled={resolving}>
                  {resolving ? <Spinner size={14} /> : <Search size={14} />} Find matching SKUs
                </Button>
                {resolved && (
                  <span className="text-[13px]" style={{ color: 'var(--h10-text-2)' }}>
                    <strong style={{ color: 'var(--h10-text)' }}>{resolved.count}</strong> SKUs
                    {' '}
                    <span style={muted(12)}>
                      ({resolved.matched} matched{resolved.truncated ? ', truncated' : ''})
                    </span>
                  </span>
                )}
              </div>

              {resolved && resolved.sample.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {resolved.truncated && (
                    <div style={{ marginBottom: 8 }}>
                      <Banner tone="warning" title="Result truncated">
                        {resolved.matched} SKUs matched but only the first {resolved.count} were kept
                        (eBay caps a promotion at 500 SKUs). Tighten the rule to narrow the set.
                      </Banner>
                    </div>
                  )}
                  <SampleSkuTable sample={resolved.sample} />
                </div>
              )}
            </div>
          ) : (
            <div>
              {label('Paste SKUs (comma, space or newline separated)')}
              <Textarea
                rows={5}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                placeholder={'SKU-001\nSKU-002\nSKU-003'}
                style={{ width: '100%' }}
              />
              <div style={{ marginTop: 8, ...muted(12) }}>
                <strong style={{ color: 'var(--h10-text-2)' }}>{manualSkus.length}</strong> SKU(s)
                entered.
              </div>
            </div>
          )}

          <div
            style={{
              marginTop: 12,
              padding: '8px 12px',
              borderRadius: 'var(--h10-radius-md)',
              background: 'var(--h10-surface-sunken)',
              fontSize: 13,
              color: 'var(--h10-text-2)',
            }}
          >
            This promotion will apply to{' '}
            <strong style={{ color: 'var(--h10-text)' }}>{effectiveSkus.length}</strong> SKU(s).
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Margin table ─────────────────────────────────────────────────────────────

function MarginTable({
  computed,
  previewing,
  hasFloor,
  floor,
  hasCost,
}: {
  computed: TierComputation[] | null
  previewing: boolean
  hasFloor: boolean
  floor: number
  hasCost: boolean
}) {
  if (!computed || computed.length === 0) {
    return (
      <div
        style={{
          padding: '20px 0',
          textAlign: 'center',
          ...muted(13),
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
        }}
      >
        {previewing ? (
          <>
            <Spinner size={14} /> Computing…
          </>
        ) : (
          'Enter a positive base price to preview buyer prices and margins.'
        )}
      </div>
    )
  }

  const th: React.CSSProperties = {
    textAlign: 'left',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--h10-text-3)',
    padding: '6px 10px',
    borderBottom: '1px solid var(--h10-border)',
  }
  const td: React.CSSProperties = {
    fontSize: 13,
    padding: '8px 10px',
    borderBottom: '1px solid var(--h10-border-subtle)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--h10-text)',
  }

  return (
    <div
      style={{
        border: '1px solid var(--h10-border)',
        borderRadius: 'var(--h10-radius-md)',
        overflow: 'hidden',
        background: 'var(--h10-surface)',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Tier</th>
            <th style={{ ...th, textAlign: 'right' }}>Discount</th>
            <th style={{ ...th, textAlign: 'right' }}>Buyer unit price</th>
            <th style={{ ...th, textAlign: 'right' }}>Your margin</th>
          </tr>
        </thead>
        <tbody>
          {computed.map((c) => {
            const below = hasFloor && c.marginPercent != null && c.marginPercent < floor
            return (
              <tr key={c.minQty}>
                <td style={{ ...td, fontWeight: 600 }}>Buy {c.minQty}+</td>
                <td style={{ ...td, textAlign: 'right' }}>{c.percentOff}%</td>
                <td style={{ ...td, textAlign: 'right' }}>€{fmtMoney(c.unitPrice)}</td>
                <td
                  style={{
                    ...td,
                    textAlign: 'right',
                    fontWeight: below ? 700 : 500,
                    color: below
                      ? 'var(--h10-danger)'
                      : c.marginPercent == null
                        ? 'var(--h10-text-3)'
                        : 'var(--h10-success-strong)',
                  }}
                >
                  {c.marginPercent == null ? (hasCost ? '—' : 'add cost') : `${c.marginPercent}%`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {hasFloor && (
        <div
          style={{
            padding: '6px 10px',
            ...muted(11),
            borderTop: '1px solid var(--h10-border-subtle)',
            background: 'var(--h10-surface-raised)',
          }}
        >
          Margins below the {floor}% floor are highlighted in red.
        </div>
      )}
    </div>
  )
}

// ── Resolved-SKU sample table ────────────────────────────────────────────────

function SampleSkuTable({ sample }: { sample: ResolvedSku[] }) {
  const columns = useMemo<Column<ResolvedSku>[]>(
    () => [
      {
        key: 'sku',
        label: 'SKU',
        render: (r) => <span style={{ fontWeight: 600, color: 'var(--h10-text)' }}>{r.sku}</span>,
      },
      {
        key: 'price',
        label: 'Price',
        align: 'right',
        render: (r) => (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--h10-text-2)' }}>
            €{fmtMoney(r.price)}
          </span>
        ),
      },
      {
        key: 'margin',
        label: 'Margin',
        align: 'right',
        render: (r) => (
          <span
            style={{
              fontVariantNumeric: 'tabular-nums',
              color: r.marginPercent == null ? 'var(--h10-text-3)' : 'var(--h10-text-2)',
            }}
          >
            {r.marginPercent == null ? '—' : `${r.marginPercent}%`}
          </span>
        ),
      },
    ],
    [],
  )
  return (
    <div>
      <div style={{ marginBottom: 6, ...muted(11) }}>Sample (first {sample.length})</div>
      <DataGrid columns={columns} rows={sample} rowKey={(r) => r.sku} maxHeight={220} />
    </div>
  )
}
