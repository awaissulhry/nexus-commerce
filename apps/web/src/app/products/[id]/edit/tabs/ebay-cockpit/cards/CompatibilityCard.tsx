'use client'

// EC.13 — CompatibilityCard
//
// Motors-only compatibility editor for the cockpit. Mounts ONLY
// when the picked category looks motors-relevant (helmet / casco /
// jacket / giacca / glove / boot / motor / moto in the category
// name or path) — otherwise the card renders a tiny "not motors"
// hint and stays out of the operator's way.
//
// Two modes:
//   • Universal fit (default) — single toggle, eBay shows the
//     listing in every motorcycle-buyer's compatibility search
//   • Specific fitments — per-row year / make / model / submodel,
//     with bulk paste, AI suggest, and a 1000-row cap (eBay's
//     ItemCompatibilityList ceiling)
//
// Persistence: PATCH /api/ebay/cockpit/compatibility writes
// platformAttributes.compatibility = { universal, fitments,
// updatedAt }. Trading API sync (XML ItemCompatibilityList) is
// EC.13b — Inventory API doesn't carry compatibility so a dedicated
// XML round-trip ships separately.

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Package, Loader2, Save, Plus, Trash2, FileText, Sparkles, AlertTriangle, ExternalLink,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'

const FITMENT_CAP = 1000

interface Fitment {
  year: string
  make: string
  model: string
  submodel?: string | null
}

interface InitialCompatibility {
  universal: boolean
  fitments: Fitment[]
  updatedAt: string | null
}

interface Props {
  productId: string
  marketplace: string
  /** Used by the motors detector — if neither name nor path mentions
   *  motorcycle keywords the card collapses to a tiny "not motors"
   *  hint instead of taking up real estate. */
  categoryName: string | null
  categoryPath: string | null
  productName: string | null
  productType: string | null
  initial: InitialCompatibility
}

function isMotorsRelevant(...candidates: Array<string | null>): boolean {
  const haystack = candidates.filter(Boolean).join(' ').toLowerCase()
  if (!haystack) return false
  return /\b(helmet|casco|jacket|giacca|giubbotto|glove|guanto|guanti|boot|stivali|stivale|motor|moto)\b/.test(haystack)
}

export default function CompatibilityCard(props: Props) {
  const router = useRouter()
  const { t } = useTranslations()
  const motors = isMotorsRelevant(
    props.categoryName,
    props.categoryPath,
    props.productName,
    props.productType,
  )

  const [universal, setUniversal] = useState(props.initial.universal)
  const [fitments, setFitments] = useState<Fitment[]>(props.initial.fitments)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)

  const initialJson = useMemo(
    () => JSON.stringify({ universal: props.initial.universal, fitments: props.initial.fitments }),
    [props.initial],
  )
  const currentJson = useMemo(
    () => JSON.stringify({ universal, fitments }),
    [universal, fitments],
  )
  const isDirty = initialJson !== currentJson

  const handleAddFitment = useCallback(() => {
    setFitments((prev) => [...prev, { year: '', make: '', model: '', submodel: '' }])
  }, [])

  const handleUpdateFitment = useCallback((i: number, patch: Partial<Fitment>) => {
    setFitments((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))
  }, [])

  const handleDeleteFitment = useCallback((i: number) => {
    setFitments((prev) => prev.filter((_, idx) => idx !== i))
  }, [])

  const handleBulkApply = useCallback((csv: string) => {
    // Accept CSV with header "year,make,model[,submodel]" OR plain
    // lines like "2020 Ducati Panigale V4". Lines split on commas
    // first; if a line has < 3 commas we fall back to whitespace.
    const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const parsed: Fitment[] = []
    let skippedHeader = false
    for (const raw of lines) {
      if (!skippedHeader && /^year[,\s]+make[,\s]+model/i.test(raw)) {
        skippedHeader = true
        continue
      }
      const parts = raw.includes(',')
        ? raw.split(',').map((p) => p.trim())
        : raw.split(/\s+/).map((p) => p.trim())
      if (parts.length < 3) continue
      const [year, make, ...rest] = parts
      const model = rest[0] ?? ''
      const submodel = rest.slice(1).join(' ') || null
      if (year && make && model) {
        parsed.push({ year, make, model, submodel })
      }
    }
    if (parsed.length === 0) {
      setError(t('products.edit.cockpit.ebay.compat.bulkNoValidRows'))
      return
    }
    setFitments((prev) => [...prev, ...parsed].slice(0, FITMENT_CAP))
    setBulkOpen(false)
    setError(null)
  }, [t])

  const handleAiSuggest = useCallback(async () => {
    if (aiLoading) return
    setAiLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/ai-improve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'compatibility',
          productId: props.productId,
          marketplace: props.marketplace,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
      if (typeof json.universal === 'boolean') setUniversal(json.universal)
      if (Array.isArray(json.fitments) && json.fitments.length > 0) {
        const cleaned: Fitment[] = json.fitments
          .map((f: Record<string, unknown>) => ({
            year: String(f?.year ?? '').trim(),
            make: String(f?.make ?? '').trim(),
            model: String(f?.model ?? '').trim(),
            submodel: f?.submodel ? String(f.submodel).trim() : null,
          }))
          .filter((f: Fitment) => f.year && f.make && f.model)
        setFitments(cleaned.slice(0, FITMENT_CAP))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAiLoading(false)
    }
  }, [aiLoading, props.productId, props.marketplace])

  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/compatibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: props.productId,
          marketplace: props.marketplace,
          universal,
          fitments: universal ? [] : fitments,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, props.productId, props.marketplace, universal, fitments, router])

  // Non-motors collapsed view.
  if (!motors) {
    return (
      <Card noPadding>
        <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
          <Package className="w-4 h-4 text-tertiary" />
          <div className="text-md font-medium text-slate-700 dark:text-slate-300">{t('products.edit.cockpit.ebay.compat.title')}</div>
          <Badge variant="info">EC.13</Badge>
          <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
            {t('products.edit.cockpit.ebay.compat.notMotors')}
          </span>
        </div>
      </Card>
    )
  }

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2 flex-wrap">
        <Package className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.compat.motorsTitle')}
        </div>
        <Badge variant="info">EC.13</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {universal ? t('products.edit.cockpit.ebay.compat.universalFit') : t('products.edit.cockpit.ebay.compat.fitmentsCount', { count: fitments.length })}
          {!universal && fitments.length >= FITMENT_CAP * 0.9 && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">
              · {t('products.edit.cockpit.ebay.compat.capLabel', { cap: FITMENT_CAP })}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={handleAiSuggest}
          disabled={aiLoading}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100 disabled:opacity-50"
          title={t('products.edit.cockpit.ebay.compat.aiSuggestTitle')}
        >
          {aiLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {t('products.edit.cockpit.ebay.compat.aiSuggest')}
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Mode toggle */}
        <div className="flex items-center gap-2 text-sm">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={universal}
              onChange={(e) => setUniversal(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {t('products.edit.cockpit.ebay.compat.universalToggleLabel')}
            </span>
          </label>
        </div>
        <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
          {universal
            ? t('products.edit.cockpit.ebay.compat.universalHelp')
            : t('products.edit.cockpit.ebay.compat.specificHelp')}
        </div>

        {/* Specific fitments editor */}
        {!universal && (
          <>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleAddFitment}
                disabled={fitments.length >= FITMENT_CAP}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
              >
                <Plus className="w-3 h-3" /> {t('products.edit.cockpit.ebay.compat.addFitment')}
              </button>
              <button
                type="button"
                onClick={() => setBulkOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <FileText className="w-3 h-3" /> {t('products.edit.cockpit.ebay.compat.bulkPaste')}
              </button>
              <span className="text-[10.5px] text-tertiary ml-auto">
                {fitments.length} / {FITMENT_CAP}
              </span>
            </div>

            {fitments.length === 0 && (
              <div className="text-xs text-tertiary italic py-2">
                {t('products.edit.cockpit.ebay.compat.emptyFitments')}
              </div>
            )}

            {fitments.length > 0 && (
              <div className="max-h-72 overflow-y-auto -mx-2 px-2">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-wide text-tertiary">
                      <th className="text-left py-1 px-1 font-medium">{t('products.edit.cockpit.ebay.compat.colYear')}</th>
                      <th className="text-left py-1 px-1 font-medium">{t('products.edit.cockpit.ebay.compat.colMake')}</th>
                      <th className="text-left py-1 px-1 font-medium">{t('products.edit.cockpit.ebay.compat.colModel')}</th>
                      <th className="text-left py-1 px-1 font-medium">{t('products.edit.cockpit.ebay.compat.colSubmodel')}</th>
                      <th className="w-6"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fitments.map((f, i) => (
                      <FitmentRow
                        key={i}
                        fitment={f}
                        onChange={(patch) => handleUpdateFitment(i, patch)}
                        onDelete={() => handleDeleteFitment(i)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {error && (
          <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        <div className="text-[10.5px] text-tertiary italic pt-1 border-t border-subtle dark:border-slate-800">
          {t('products.edit.cockpit.ebay.compat.persistenceNote')}
        </div>
      </div>

      <div className="px-4 py-2.5 border-t border-subtle dark:border-slate-800 flex items-center gap-2">
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {isDirty ? t('products.edit.cockpit.ebay.compat.unsavedChanges') : t('products.edit.cockpit.ebay.compat.allSaved')}
        </span>
        {savedFlash && (
          <span className="text-xs text-emerald-700 dark:text-emerald-300">{t('products.edit.cockpit.ebay.compat.savedFlash')}</span>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !isDirty}
          className="ml-auto px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
          {saving ? t('products.edit.cockpit.ebay.compat.saving') : t('products.edit.cockpit.ebay.compat.saveButton')}
        </button>
      </div>

      {bulkOpen && (
        <BulkPasteModal
          onApply={handleBulkApply}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </Card>
  )
}

function FitmentRow({
  fitment, onChange, onDelete,
}: {
  fitment: Fitment
  onChange: (patch: Partial<Fitment>) => void
  onDelete: () => void
}) {
  const { t } = useTranslations()
  return (
    <tr className="border-t border-subtle dark:border-slate-800">
      <td className="py-1 px-1">
        <input
          type="text"
          value={fitment.year}
          onChange={(e) => onChange({ year: e.target.value })}
          placeholder="2024"
          className="w-16 text-xs border border-default dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="py-1 px-1">
        <input
          type="text"
          value={fitment.make}
          onChange={(e) => onChange({ make: e.target.value })}
          placeholder="Ducati"
          className="w-24 text-xs border border-default dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="py-1 px-1">
        <input
          type="text"
          value={fitment.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="Panigale V4"
          className="w-32 text-xs border border-default dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="py-1 px-1">
        <input
          type="text"
          value={fitment.submodel ?? ''}
          onChange={(e) => onChange({ submodel: e.target.value })}
          placeholder={t('products.edit.cockpit.ebay.compat.submodelPlaceholder')}
          className="w-24 text-xs border border-default dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
        />
      </td>
      <td className="py-1 px-1">
        <button
          type="button"
          onClick={onDelete}
          className="p-0.5 text-tertiary hover:text-rose-600"
          aria-label={t('products.edit.cockpit.ebay.compat.deleteFitment')}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </td>
    </tr>
  )
}

function BulkPasteModal({
  onApply, onClose,
}: { onApply: (csv: string) => void; onClose: () => void }) {
  const { t } = useTranslations()
  const [text, setText] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg mx-4 rounded-lg border border-default dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-subtle dark:border-slate-800">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('products.edit.cockpit.ebay.compat.bulkModalTitle')}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {t('products.edit.cockpit.ebay.compat.bulkFormatPrefix')} <span className="font-mono">year,make,model[,submodel]</span> {t('products.edit.cockpit.ebay.compat.bulkFormatSuffix')}
          </div>
        </div>
        <div className="p-4 space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            autoFocus
            placeholder={'2024,Ducati,Panigale V4\n2023,Yamaha,MT-09\n2022,Honda,CBR1000RR'}
            className="w-full text-xs font-mono border border-default dark:border-slate-700 rounded p-2 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
          <div className="text-[10.5px] text-tertiary inline-flex items-center gap-1">
            <ExternalLink className="w-3 h-3" /> {t('products.edit.cockpit.ebay.compat.bulkTip')}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800">
            {t('products.edit.cockpit.ebay.compat.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onApply(text)}
            disabled={text.trim().length === 0}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700',
              text.trim().length === 0 && 'opacity-50',
            )}
          >
            {t('products.edit.cockpit.ebay.compat.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
