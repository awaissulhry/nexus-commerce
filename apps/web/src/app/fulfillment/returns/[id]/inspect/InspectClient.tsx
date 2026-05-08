'use client'

// R3.1 — Mobile inspection workspace.
//
// Reaches the warehouse worker on tablets / phones / scan-gun
// terminals; replaces the desktop drawer's cramped per-item inspect
// flow with a single-column screen optimized for thumb-reach +
// scan-driven navigation. All mutations call the existing R0/R2.2
// endpoints — no new backend surface for this commit.
//
// Workflow:
//   1. Page loads with the Return preloaded (server route gives us
//      the id; client fetches the detail).
//   2. Optional: scan an item label to focus that item's card.
//   3. For each item: tap a big condition-grade pill, optionally
//      tick the checklist, shoot photos with the camera, type
//      notes. Each item card auto-saves notes + checklist on edit
//      (PATCH /returns/:id/items/:itemId). The condition grade is
//      staged locally; the bottom CTA submits all grades in one
//      /inspect call (matching the existing inspect semantics).
//   4. Tap "Save inspection" → bulk inspect → status flips to
//      INSPECTING → page redirects back to the desktop workspace
//      (where the operator chooses Restock / Scrap).

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, Camera, CheckCircle2, ImageIcon as ImageIconLucide,
  ScanLine, Save, Loader2, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { BarcodeScanInput } from '@/components/ui/BarcodeScanInput'
import { Barcode128 } from '@/components/ui/Barcode128'
import { getBackendUrl } from '@/lib/backend-url'

const GRADES = [
  { value: 'NEW',       label: 'NEW',        tone: 'bg-emerald-600 text-white' },
  { value: 'LIKE_NEW',  label: 'Like new',   tone: 'bg-emerald-500 text-white' },
  { value: 'GOOD',      label: 'Good',       tone: 'bg-blue-500 text-white' },
  { value: 'DAMAGED',   label: 'Damaged',    tone: 'bg-amber-500 text-white' },
  { value: 'UNUSABLE',  label: 'Unusable',   tone: 'bg-rose-600 text-white' },
] as const

type Grade = typeof GRADES[number]['value']

type ItemChecklist = {
  packagingPresent?: boolean
  tagsIntact?: boolean
  visibleDamage?: boolean
  damageNotes?: string
  functionalTestPassed?: boolean | null
  signsOfUse?: 'NONE' | 'LIGHT' | 'HEAVY'
}

type Disposition = 'SELLABLE' | 'SECOND_QUALITY' | 'REFURBISH' | 'QUARANTINE' | 'SCRAP'

const DISPOSITIONS: ReadonlyArray<{ value: Disposition; label: string; tone: string }> = [
  { value: 'SELLABLE',       label: 'Sellable',       tone: 'bg-emerald-600 text-white' },
  { value: 'SECOND_QUALITY', label: '2nd quality',    tone: 'bg-blue-500 text-white'    },
  { value: 'REFURBISH',      label: 'Refurbish',      tone: 'bg-violet-500 text-white'  },
  { value: 'QUARANTINE',     label: 'Quarantine',     tone: 'bg-amber-500 text-white'   },
  { value: 'SCRAP',          label: 'Scrap',          tone: 'bg-rose-600 text-white'    },
]

type ItemRow = {
  id: string
  sku: string
  productId: string | null
  quantity: number
  conditionGrade: Grade | null
  notes: string | null
  photoUrls: string[]
  inspectionChecklist: ItemChecklist | null
  // R3.2 — disposition routing.
  disposition: Disposition | null
  scrapReason: string | null
}

type ReturnDetail = {
  id: string
  rmaNumber: string | null
  channel: string
  status: string
  isFbaReturn: boolean
  reason: string | null
  notes: string | null
  items: ItemRow[]
}

const STATUS_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  REQUESTED: 'default', AUTHORIZED: 'info', IN_TRANSIT: 'info',
  RECEIVED: 'warning', INSPECTING: 'warning', RESTOCKED: 'success',
  REFUNDED: 'success', REJECTED: 'danger', SCRAPPED: 'danger',
}

export default function InspectClient({ returnId }: { returnId: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [ret, setRet] = useState<ReturnDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  // Staged condition grades by itemId. Auto-applied on bulk save.
  const [grades, setGrades] = useState<Record<string, Grade>>({})
  // R3.2 — staged dispositions by itemId. Pre-seeded from the
  // server (so re-entries don't lose the operator's prior choice)
  // and auto-derived from the grade when the operator picks one
  // before disposition.
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({})
  // Per-item scrap reason — only sent when disposition is SCRAP.
  const [scrapReasons, setScrapReasons] = useState<Record<string, string>>({})
  // Highlight the most recently scanned item card so the operator
  // sees their scan landed on the right row.
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null)
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const fetchOne = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${returnId}`, {
        cache: 'no-store',
      })
      if (res.ok) {
        const data = (await res.json()) as ReturnDetail
        setRet(data)
        // Pre-stage existing grades so the pills show what's already on
        // the row (operator can re-tap to change).
        const seed: Record<string, Grade> = {}
        const seedDisp: Record<string, Disposition> = {}
        const seedReason: Record<string, string> = {}
        for (const it of data.items) {
          if (it.conditionGrade) seed[it.id] = it.conditionGrade
          if (it.disposition) seedDisp[it.id] = it.disposition
          if (it.scrapReason) seedReason[it.id] = it.scrapReason
        }
        setGrades(seed)
        setDispositions(seedDisp)
        setScrapReasons(seedReason)
      } else if (res.status === 404) {
        toast.error('Return not found')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [returnId, toast])
  useEffect(() => { void fetchOne() }, [fetchOne])

  // Scan handling: USB scanners + the camera mode in BarcodeScanInput
  // both feed into onScan. Match either the SKU or the product
  // barcode (treated as SKU here). Multiple items with the same SKU
  // get the first one focused — operators with multi-line returns
  // can manually tap others.
  const onScan = useCallback((value: string) => {
    if (!ret) return
    const v = value.trim()
    if (!v) return
    const hit = ret.items.find((it) => it.sku.toLowerCase() === v.toLowerCase())
    if (!hit) {
      toast.error(`No item on this return matches "${v}"`)
      return
    }
    setFocusedItemId(hit.id)
    // Scroll into view. block: 'center' so the scanned card lands in
    // the operator's reading zone, not behind the sticky header.
    itemRefs.current[hit.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    toast.success(`${hit.sku} — ${hit.quantity}× ${hit.conditionGrade ?? 'pending'}`)
  }, [ret, toast])

  const submitInspection = useCallback(async () => {
    if (!ret) return
    const items = ret.items
      .map((it) => ({
        itemId: it.id,
        conditionGrade: grades[it.id],
        disposition: dispositions[it.id],
        scrapReason: scrapReasons[it.id]?.trim() || undefined,
      }))
      .filter((u): u is typeof u & { conditionGrade: Grade } => !!u.conditionGrade)
    if (items.length === 0) {
      toast.error('Grade at least one item before saving')
      return
    }
    if (items.length < ret.items.length) {
      const ok = await askConfirm({
        title: 'Save with ungraded items?',
        description: `${ret.items.length - items.length} of ${ret.items.length} items have no grade yet. Save anyway?`,
        confirmLabel: 'Save',
        tone: 'warning',
      })
      if (!ok) return
    }
    // Sanity: SCRAP without a reason → confirm. The server allows
    // null scrapReason, but operators usually want a paper trail.
    const scrapNoReason = items.filter(
      (i) => i.disposition === 'SCRAP' && !i.scrapReason,
    )
    if (scrapNoReason.length > 0) {
      const ok = await askConfirm({
        title: `Scrap ${scrapNoReason.length} item(s) without a reason?`,
        description: 'Adding a scrap reason makes the write-off auditable. You can save without one but it will be harder to explain later.',
        confirmLabel: 'Save anyway',
        tone: 'warning',
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/inspect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      toast.success('Inspection saved')
      // Land back on the desktop drawer so the operator can pick the
      // restock vs scrap action with the larger context.
      router.push(`/fulfillment/returns?drawer=${returnId}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }, [ret, grades, dispositions, scrapReasons, returnId, askConfirm, toast, router])

  // Auto-derive disposition from grade when the operator picks a
  // grade but hasn't touched the disposition picker yet. Operators
  // can override any time.
  const deriveDisposition = useCallback((grade: Grade): Disposition => {
    if (grade === 'NEW' || grade === 'LIKE_NEW' || grade === 'GOOD') return 'SELLABLE'
    return 'SCRAP'
  }, [])
  const onGradeChange = useCallback((itemId: string, grade: Grade) => {
    setGrades((prev) => ({ ...prev, [itemId]: grade }))
    setDispositions((prev) => prev[itemId] ? prev : { ...prev, [itemId]: deriveDisposition(grade) })
  }, [deriveDisposition])

  if (loading || !ret) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-slate-400" />
      </div>
    )
  }

  if (ret.isFbaReturn) {
    return (
      <div className="min-h-screen bg-slate-50">
        <div className="max-w-md mx-auto p-4">
          <Link
            href="/fulfillment/returns"
            className="inline-flex items-center gap-1.5 text-base text-slate-600 hover:text-slate-900 mb-4"
          >
            <ArrowLeft size={14} /> Back to returns
          </Link>
          <div className="bg-white border border-amber-200 rounded p-5 text-base">
            <div className="font-semibold text-amber-800 mb-1">FBA return — managed by Amazon</div>
            <div className="text-slate-700">
              FBA returns mirror read-only from Amazon and don&apos;t flow through warehouse inspection.
              Use the desktop workspace to view detail.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const allGraded = ret.items.length > 0 && ret.items.every((it) => grades[it.id])
  const gradedCount = ret.items.filter((it) => grades[it.id]).length

  return (
    <div className="min-h-screen bg-slate-50 pb-32">
      {/* Sticky header — small enough that the per-item cards still
          dominate the viewport on a phone. */}
      <header className="sticky top-0 z-10 bg-white border-b border-slate-200">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link
            href={`/fulfillment/returns?drawer=${returnId}`}
            className="h-11 w-11 -ml-2 inline-flex items-center justify-center rounded-md hover:bg-slate-100"
            aria-label="Back to returns"
          >
            <ArrowLeft size={18} />
          </Link>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">Inspect</div>
            <div className="text-lg font-mono text-slate-900 truncate">{ret.rmaNumber ?? '—'}</div>
          </div>
          <Badge variant={STATUS_TONE[ret.status] ?? 'default'} size="sm">
            {ret.status.replace(/_/g, ' ')}
          </Badge>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-4 space-y-3">
        {/* Compact RMA barcode for warehouse identification — small
            so it doesn't dominate; printed labels render larger. */}
        {ret.rmaNumber && (
          <div className="bg-white border border-slate-200 rounded p-3 flex justify-center">
            <Barcode128 value={ret.rmaNumber} moduleWidthPx={1.2} height={40} />
          </div>
        )}

        {/* Scan input — autofocus so a USB scanner gun's first read
            lands here without a tap. Camera toggle lets a phone-only
            operator switch in. */}
        <div className="bg-white border border-slate-200 rounded p-3">
          <BarcodeScanInput
            label="Scan item barcode"
            placeholder="Scan SKU or product barcode…"
            onScan={onScan}
            autoFocus
          />
          <div className="mt-1.5 text-xs text-slate-500 inline-flex items-center gap-1.5">
            <ScanLine size={11} />
            {gradedCount} / {ret.items.length} graded
          </div>
        </div>

        {ret.reason && (
          <div className="bg-white border border-slate-200 rounded p-3 text-base">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5">
              Customer reason
            </div>
            <div className="text-slate-800">{ret.reason}</div>
          </div>
        )}

        {ret.items.map((it) => (
          <div
            key={it.id}
            ref={(el) => { itemRefs.current[it.id] = el }}
            className={`bg-white rounded border p-3 space-y-3 ${
              focusedItemId === it.id
                ? 'border-blue-500 ring-1 ring-blue-200'
                : 'border-slate-200'
            }`}
          >
            <ItemHeader item={it} graded={!!grades[it.id]} />
            <GradePicker
              value={grades[it.id]}
              onChange={(g) => onGradeChange(it.id, g)}
            />
            <DispositionPicker
              value={dispositions[it.id]}
              scrapReason={scrapReasons[it.id] ?? ''}
              onChange={(d) => setDispositions((p) => ({ ...p, [it.id]: d }))}
              onScrapReasonChange={(r) => setScrapReasons((p) => ({ ...p, [it.id]: r }))}
            />
            <ItemChecklistEditor
              returnId={returnId}
              item={it}
              onChanged={fetchOne}
            />
            <ItemPhotoGallery
              returnId={returnId}
              item={it}
              onChanged={fetchOne}
              askConfirm={askConfirm}
              toast={toast}
            />
            <ItemNotesEditor
              returnId={returnId}
              item={it}
              onChanged={fetchOne}
            />
          </div>
        ))}
      </main>

      {/* Sticky bottom CTA. Big enough for thumb tap on a phone.
          Disabled until at least one item is graded. */}
      <div className="fixed bottom-0 inset-x-0 z-10 bg-white border-t border-slate-200 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)]">
        <div className="max-w-2xl mx-auto">
          <button
            onClick={submitInspection}
            disabled={busy || gradedCount === 0}
            className={`w-full h-14 text-lg font-semibold rounded inline-flex items-center justify-center gap-2 transition-colors ${
              allGraded
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                : 'bg-slate-900 hover:bg-slate-800 text-white'
            } disabled:opacity-50`}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
            {busy ? 'Saving…' : `Save inspection (${gradedCount}/${ret.items.length})`}
          </button>
        </div>
      </div>
    </div>
  )
}

function ItemHeader({ item, graded }: { item: ItemRow; graded: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="font-mono text-base text-slate-900 truncate">{item.sku}</div>
        <div className="text-sm text-slate-500 tabular-nums">Qty {item.quantity}</div>
      </div>
      {graded && (
        <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
      )}
    </div>
  )
}

// Big finger-friendly grade picker. 5 pills wrap to 2 rows on phone.
function GradePicker({
  value, onChange,
}: {
  value: Grade | undefined
  onChange: (g: Grade) => void
}) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
      {GRADES.map((g) => {
        const active = value === g.value
        return (
          <button
            key={g.value}
            onClick={() => onChange(g.value)}
            className={`h-11 px-2 text-sm font-semibold rounded border ${
              active
                ? `${g.tone} border-transparent shadow-sm`
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {g.label}
          </button>
        )
      })}
    </div>
  )
}

// R3.2 — disposition picker. Drives where the unit goes after
// inspection. Auto-seeded from the grade (operator can override at
// any time). When SCRAP is picked, a reason input slides out below
// the pills so operators can record why we're writing off the unit.
function DispositionPicker({
  value, scrapReason, onChange, onScrapReasonChange,
}: {
  value: Disposition | undefined
  scrapReason: string
  onChange: (d: Disposition) => void
  onScrapReasonChange: (r: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
        Disposition
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
        {DISPOSITIONS.map((d) => {
          const active = value === d.value
          return (
            <button
              key={d.value}
              onClick={() => onChange(d.value)}
              className={`h-11 px-2 text-sm font-semibold rounded border ${
                active
                  ? `${d.tone} border-transparent shadow-sm`
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {d.label}
            </button>
          )
        })}
      </div>
      {value === 'SCRAP' && (
        <div>
          <input
            type="text"
            value={scrapReason}
            onChange={(e) => onScrapReasonChange(e.target.value)}
            placeholder="Scrap reason (defective, contaminated, missing parts…)"
            className="w-full h-10 px-2 text-base border border-rose-200 bg-rose-50 rounded focus:outline-none focus:ring-1 focus:ring-rose-400 placeholder-rose-400"
          />
        </div>
      )}
    </div>
  )
}

function ItemChecklistEditor({
  returnId, item, onChanged,
}: {
  returnId: string
  item: ItemRow
  onChanged: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [checklist, setChecklist] = useState<ItemChecklist>(item.inspectionChecklist ?? {})
  const [busy, setBusy] = useState(false)
  useEffect(() => { setChecklist(item.inspectionChecklist ?? {}) }, [item.inspectionChecklist])
  const dirty = JSON.stringify(checklist) !== JSON.stringify(item.inspectionChecklist ?? {})
  const save = async () => {
    if (!dirty) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inspectionChecklist: Object.keys(checklist).length > 0 ? checklist : null,
          }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }
  // Auto-save 300ms after the last toggle so the operator's quick taps
  // don't fire one PATCH per click.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => { void save() }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklist])
  const setChk = (patch: Partial<ItemChecklist>) =>
    setChecklist((prev) => ({ ...prev, ...patch }))

  return (
    <div className="space-y-1.5 text-sm">
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold inline-flex items-center gap-2">
        Checklist
        {busy && <Loader2 size={11} className="animate-spin text-slate-400" />}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {([
          ['packagingPresent', 'Original packaging'],
          ['tagsIntact', 'Tags intact'],
          ['visibleDamage', 'Visible damage'],
          ['functionalTestPassed', 'Functional test'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setChk({ [key]: !checklist[key] } as Partial<ItemChecklist>)}
            className={`h-11 px-3 text-sm rounded border inline-flex items-center justify-between ${
              checklist[key]
                ? 'bg-blue-50 border-blue-300 text-blue-900'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            <span>{label}</span>
            {checklist[key] && <CheckCircle2 size={13} className="text-blue-600" />}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5 pt-1">
        <span className="text-slate-500 text-xs">Signs of use:</span>
        {(['NONE', 'LIGHT', 'HEAVY'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setChk({ signsOfUse: s })}
            className={`h-9 px-2.5 text-sm rounded border ${
              checklist.signsOfUse === s
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function ItemPhotoGallery({
  returnId, item, onChanged, askConfirm, toast,
}: {
  returnId: string
  item: ItemRow
  onChanged: () => void | Promise<void>
  askConfirm: ReturnType<typeof useConfirm>
  toast: ReturnType<typeof useToast>['toast']
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const upload = async (file: File) => {
    if (!file) return
    if (item.photoUrls.length >= 10) {
      toast.error('Photo cap reached (10 per item)')
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}/upload-photo`,
        { method: 'POST', body: fd },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (url: string) => {
    if (!(await askConfirm({
      title: 'Remove photo?',
      description: 'The image stays in Cloudinary but is unlinked.',
      confirmLabel: 'Remove',
      tone: 'danger',
    }))) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}/photos`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Remove failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-1 inline-flex items-center gap-1.5">
        <ImageIconLucide size={11} /> Photos ({item.photoUrls.length}/10)
      </div>
      {item.photoUrls.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-1.5">
          {item.photoUrls.map((u) => (
            <div key={u} className="relative">
              <a href={u} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u}
                  alt="Item condition"
                  className="w-full h-24 object-cover rounded border border-slate-200"
                />
              </a>
              <button
                onClick={() => remove(u)}
                className="absolute top-1 right-1 h-7 w-7 inline-flex items-center justify-center rounded-full bg-white/90 text-slate-700 hover:bg-rose-50 hover:text-rose-700 shadow-sm"
                title="Remove photo"
                aria-label="Remove photo"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        // capture="environment" → on phones, prefers the rear camera so
        // the operator can shoot the item right where they're standing.
        capture="environment"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void upload(f)
          e.target.value = ''
        }}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={busy || item.photoUrls.length >= 10}
        className="w-full h-11 px-3 text-sm font-medium border border-slate-300 border-dashed rounded text-slate-700 hover:bg-slate-50 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
      >
        <Camera size={14} /> {busy ? 'Uploading…' : 'Capture / upload photo'}
      </button>
    </div>
  )
}

function ItemNotesEditor({
  returnId, item, onChanged,
}: {
  returnId: string
  item: ItemRow
  onChanged: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [value, setValue] = useState(item.notes ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setValue(item.notes ?? '') }, [item.notes])
  const dirty = value !== (item.notes ?? '')
  const save = async () => {
    if (!dirty) return
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${returnId}/items/${item.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: value || null }),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-0.5 inline-flex items-center gap-2">
        Notes
        {dirty && <span className="text-amber-600 normal-case font-normal text-[11px]">unsaved</span>}
      </div>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        rows={2}
        placeholder="Defect location, observations…"
        className="w-full px-2 py-2 text-base border border-slate-200 rounded resize-y focus:outline-none focus:ring-1 focus:ring-slate-400"
      />
      {busy && (
        <div className="mt-1 text-xs text-slate-500 inline-flex items-center gap-1">
          <Loader2 size={11} className="animate-spin" /> Saving…
        </div>
      )}
    </div>
  )
}
