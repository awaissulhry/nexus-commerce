'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Printer, FileDown, Loader2, Globe, AlertTriangle, Package, X as XIcon } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { SkuPanel } from './SkuPanel'
import { LabelPreview } from './LabelPreview'
import { TemplateSidebar } from './TemplateSidebar'
import { buildPrintHtml } from './print-utils'
import { isValidFnskuFormat } from './fnsku-validation'
import type { LabelItem, TemplateConfig, SavedTemplate } from './types'

// Amazon EU FBA destination markets — Xavia's primary IT first, then
// the most common 2nd/3rd-order destinations (DE/FR/ES/NL). UK is post-Brexit
// separate. The label's listing title is loaded per selected marketplace so
// it matches the destination FC's listing exactly (FBA requirement).
const MARKETPLACES: Array<{ code: string; label: string }> = [
  { code: 'IT', label: 'Italy (IT)' },
  { code: 'DE', label: 'Germany (DE)' },
  { code: 'FR', label: 'France (FR)' },
  { code: 'ES', label: 'Spain (ES)' },
  { code: 'NL', label: 'Netherlands (NL)' },
  { code: 'BE', label: 'Belgium (BE)' },
  { code: 'PL', label: 'Poland (PL)' },
  { code: 'SE', label: 'Sweden (SE)' },
  { code: 'IE', label: 'Ireland (IE)' },
  { code: 'UK', label: 'United Kingdom (UK)' },
]

const DEFAULT_TEMPLATE: TemplateConfig = {
  labelSize: { widthMm: 101.6, heightMm: 76.2, preset: '4x3in' },
  // Layout
  columnSplitPct: 38,
  paddingMm: 2,
  showColumnDivider: true,
  // Logo
  logoUrl: '',
  showLogo: true,
  // Size box
  showSizeBox: true,
  sizeBoxLabel: 'SIZE',
  // Barcode
  barcodeHeightPct: 32,
  barcodeWidthPct: 100,
  // Listing
  showListingTitle: true,
  listingTitleLines: 2,
  showCondition: true,
  condition: 'New',
  // Typography
  fontFamily: 'Helvetica',
  badgeFontScale: 1.0,
  valueFontScale: 1.0,
  // Label border
  labelRadiusMm: 5,
  // Fine-grained scales
  sizeValueScale: 1.0,
  sizeHeaderScale: 1.0,
  fnskuTextScale: 1.0,
  listingTitleScale: 1.0,
  conditionScale: 1.0,
  logoHeightPct: 22,
  // Title truncation
  titleTruncationMode: 'lines' as const,
  titleFirstWords: 5,
  titleLastWords: 4,
  // Rows
  rows: [
    { id: '1', badgeText: 'MODEL', valueSource: 'productName', customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
    { id: '2', badgeText: 'COLOR', valueSource: 'color',       customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
    { id: '3', badgeText: 'GEN.',  valueSource: 'gender',      customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true },
  ],
}

export default function FnskuLabelDesigner() {
  const [items, setItems] = useState<LabelItem[]>(() => {
    try {
      const saved = localStorage.getItem('fnsku-label-items')
      if (!saved) return []
      const parsed: LabelItem[] = JSON.parse(saved)
      // Normalise in case of corruption: ensure quantity is always >= 1
      return parsed.map(it => ({ ...it, quantity: Math.max(1, it.quantity || 1) }))
    } catch (e) {
      console.warn('[fnsku-labels] Failed to restore items from localStorage:', e)
      return []
    }
  })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [template, setTemplate] = useState<TemplateConfig>(DEFAULT_TEMPLATE)
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [fetchingFnskus, setFetchingFnskus] = useState(false)
  const [pdfLoading, setPdfLoading] = useState<'label' | 'a4' | null>(null)
  const [marketplace, setMarketplace] = useState<string>(() => {
    try { return localStorage.getItem('fnsku-label-marketplace') || 'IT' }
    catch { return 'IT' }
  })
  // Shipment pre-fill context (set when ?shipmentId= present in URL).
  const [shipmentContext, setShipmentContext] = useState<{ id: string; reference: string | null } | null>(null)
  const [shipmentLoading, setShipmentLoading] = useState(false)
  const [shipmentError, setShipmentError] = useState<string | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

  // On mount: fetch metadata for localStorage-restored items missing FNSKU or listing title
  useEffect(() => {
    const needsMeta = items.filter(it => it.sku && (!it.fnsku || !it.listingTitle))
    if (needsMeta.length > 0) fetchFnskus(needsMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On mount: if ?shipmentId= is present, pre-fill the queue from that
  // inbound shipment's items (SKU + quantityExpected). Replaces any
  // localStorage-restored queue — opening from /inbound is an explicit
  // "use this shipment's items" action.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const shipmentId = params.get('shipmentId')
    if (!shipmentId) return

    setShipmentLoading(true)
    setShipmentError(null)
    fetch(`${getBackendUrl()}/api/fulfillment/inbound/${encodeURIComponent(shipmentId)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`Shipment ${shipmentId} not found (${r.status})`)
        return r.json()
      })
      .then((shipment: any) => {
        const rows: Array<{ sku: string; quantityExpected: number }> = shipment?.items ?? []
        if (rows.length === 0) {
          setShipmentError('Shipment has no items')
          return
        }
        // Coalesce duplicate SKUs (defensive) — sum quantities.
        const merged = new Map<string, number>()
        for (const r of rows) {
          if (!r.sku) continue
          merged.set(r.sku, (merged.get(r.sku) ?? 0) + Math.max(1, r.quantityExpected || 1))
        }
        const seeded: LabelItem[] = Array.from(merged.entries()).map(([sku, qty]) => ({
          sku,
          fnsku: '',
          quantity: qty,
          productName: null,
          listingTitle: null,
          variationAttributes: {},
          imageUrl: null,
          fnskuLoading: true,
        }))
        setItems(seeded)
        try { localStorage.setItem('fnsku-label-items', JSON.stringify(seeded)) } catch {}
        setShipmentContext({
          id: shipment.id,
          reference: shipment.reference ?? shipment.name ?? null,
        })
        // Kick off FNSKU + listing-title enrichment via the existing path.
        fetchFnskus(seeded, true)
      })
      .catch((e: any) => setShipmentError(e?.message ?? 'Failed to load shipment'))
      .finally(() => setShipmentLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load saved templates on mount
  useEffect(() => {
    fetch(`${getBackendUrl()}/api/fulfillment/fnsku/templates`)
      .then(r => r.json())
      .then(d => {
        const list: SavedTemplate[] = d?.items ?? []
        setSavedTemplates(list)
        const def = list.find(t => t.isDefault) ?? list[0]
        if (def) {
          setActiveTemplateId(def.id)
          setTemplate(def.config as TemplateConfig)
        }
      })
      .catch(() => {})
  }, [])

  // Abort controller for the in-flight lookup — prevents stale responses
  // from overwriting manual edits when multiple lookups race.
  const lookupAbortRef = useRef<AbortController | null>(null)

  const fetchFnskus = useCallback(async (targetItems: LabelItem[], force = false, mpOverride?: string) => {
    const mp = mpOverride ?? marketplace
    const needsFnsku = force
      ? targetItems.filter(it => it.sku)
      : targetItems.filter(it => (!it.fnsku || !it.listingTitle) && it.sku)
    if (needsFnsku.length === 0) return

    // Cancel any in-flight request before starting a new one
    lookupAbortRef.current?.abort()
    const controller = new AbortController()
    lookupAbortRef.current = controller

    setFetchingFnskus(true)
    setItems(prev => prev.map(it =>
      needsFnsku.some(n => n.sku === it.sku) ? { ...it, fnskuLoading: true } : it,
    ))
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: needsFnsku.map(it => it.sku), marketplace: mp }),
        signal: controller.signal,
      })
      const data = await res.json()
      const results: any[] = data?.results ?? []
      setItems(prev => prev.map(it => {
        const hit = results.find((r: any) => r.sku === it.sku)
        if (!hit) return { ...it, fnskuLoading: false }
        // Never overwrite a manually-typed FNSKU — even on force re-fetch.
        // Other fields (listing title, image, attrs) can still refresh.
        const protectedFnsku = it.manuallyEdited ? it.fnsku : (hit.fnsku ?? it.fnsku)
        return {
          ...it,
          fnskuLoading: false,
          fnsku: protectedFnsku,
          asin: it.asin ?? hit.asin ?? null,
          fnskuError: hit.error,
          productName: it.productName ?? hit.productName,
          // Force re-fetch overwrites listing title — needed when the user
          // changes destination marketplace and titles must reload for that mp.
          listingTitle: force ? (hit.listingTitle ?? it.listingTitle) : (it.listingTitle ?? hit.listingTitle),
          variationAttributes: Object.keys(it.variationAttributes).length > 0
            ? it.variationAttributes
            : (hit.variationAttributes ?? {}),
          imageUrl: it.imageUrl ?? hit.imageUrl,
        }
      }))
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        setItems(prev => prev.map(it => ({ ...it, fnskuLoading: false })))
      }
    } finally {
      if (!controller.signal.aborted) setFetchingFnskus(false)
    }
  }, [marketplace])

  const handleMarketplaceChange = (next: string) => {
    setMarketplace(next)
    try { localStorage.setItem('fnsku-label-marketplace', next) } catch {}
    // Force re-fetch with the new marketplace explicitly — don't wait for the
    // closure to refresh on next render.
    if (items.length > 0) fetchFnskus(items, true, next)
  }

  const handleItemsChange = useCallback((next: LabelItem[]) => {
    setItems(next)
    setSelectedIdx(i => Math.min(i, Math.max(0, next.length - 1)))
    try {
      localStorage.setItem('fnsku-label-items', JSON.stringify(next))
    } catch (e) {
      console.warn('[fnsku-labels] localStorage quota exceeded — label queue not persisted:', e)
    }
    // Auto-fetch for items missing FNSKU or listing title
    const newOnes = next.filter(it => (!it.fnsku || !it.listingTitle) && !it.fnskuLoading && it.sku)
    if (newOnes.length > 0) fetchFnskus(newOnes)
  }, [fetchFnskus])

  const handlePrint = () => {
    const allLabels: LabelItem[] = []
    for (const it of items) {
      for (let i = 0; i < Math.max(1, it.quantity); i++) allLabels.push(it)
    }
    const html = buildPrintHtml(allLabels, template)
    // Use a Blob URL so the page loads fully before print() fires,
    // avoiding document.write() quirks and popup-blocker issues.
    const blob = new Blob([html], { type: 'text/html; charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const w    = window.open(url, '_blank', 'noopener')
    if (w) w.addEventListener('load', () => { w.print(); URL.revokeObjectURL(url) }, { once: true })
  }

  const handleDownloadPdf = async (mode: 'label' | 'a4') => {
    // Pre-flight: missing listing title (FBA requirement)
    if (template.showListingTitle) {
      const missingTitle = items.filter(it => !it.listingTitle)
      if (missingTitle.length > 0) {
        const skus = missingTitle.map(it => it.sku).join(', ')
        const proceed = window.confirm(
          `${missingTitle.length} item${missingTitle.length > 1 ? 's' : ''} missing listing title (${skus}).\n\n` +
          `Amazon FBA requires the listing title on every label.\n\n` +
          `Click OK to generate anyway, or Cancel to fix first.`,
        )
        if (!proceed) return
      }
    }

    // Pre-flight: malformed FNSKU (must be X + 9 alphanumeric)
    const malformed = items.filter(it => it.fnsku && !isValidFnskuFormat(it.fnsku))
    if (malformed.length > 0) {
      const skus = malformed.map(it => `${it.sku}: "${it.fnsku}"`).join('\n')
      const proceed = window.confirm(
        `${malformed.length} FNSKU${malformed.length > 1 ? 's' : ''} look${malformed.length === 1 ? 's' : ''} invalid:\n\n${skus}\n\n` +
        `Amazon FNSKUs are exactly 10 alphanumeric chars starting with X (e.g. X0029S704D).\n\n` +
        `Click OK to generate anyway, or Cancel to fix first.`,
      )
      if (!proceed) return
    }

    const allLabels: LabelItem[] = []
    for (const it of items) {
      for (let i = 0; i < Math.max(1, it.quantity); i++) allLabels.push(it)
    }
    setPdfLoading(mode)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: allLabels, template, mode }),
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = mode === 'a4' ? 'fnsku-labels-a4.pdf' : 'fnsku-labels.pdf'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      alert(`PDF generation failed: ${err?.message ?? String(err)}`)
    } finally {
      setPdfLoading(null)
    }
  }

  const saveTemplate = async (name: string) => {
    const body = JSON.stringify({ name, config: template })
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const saved = await res.json()
    setSavedTemplates(prev => [...prev, saved])
    setActiveTemplateId(saved.id)
  }

  const updateTemplate = async (id: string, patch: Partial<TemplateConfig & { name: string }>) => {
    await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    setSavedTemplates(prev => prev.map(t => t.id === id ? { ...t, ...patch, config: template } : t))
  }

  const deleteTemplate = async (id: string) => {
    await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/templates/${id}`, { method: 'DELETE' })
    setSavedTemplates(prev => prev.filter(t => t.id !== id))
    setActiveTemplateId(null)
    setTemplate(DEFAULT_TEMPLATE)
  }

  const loadTemplate = (t: SavedTemplate) => {
    setActiveTemplateId(t.id)
    setTemplate(t.config as TemplateConfig)
  }

  const totalLabelCount = items.reduce((s, it) => s + Math.max(1, it.quantity), 0)

  // Per-sheet capacity — mirrors computeSheetLayout() in the PDF service exactly
  const { widthMm, heightMm } = template.labelSize
  const sheetMarginMm = template.sheetMarginMm ?? 5
  const sheetGapMm    = template.sheetGapMm    ?? 2
  const autoCols      = Math.max(1, Math.floor((210 - 2 * sheetMarginMm + sheetGapMm) / (widthMm + sheetGapMm)))
  const a4Cols        = template.sheetCols && template.sheetCols > 0 ? template.sheetCols : autoCols
  const a4Rows        = Math.max(1, Math.floor((297 - 2 * sheetMarginMm + sheetGapMm) / (heightMm + sheetGapMm)))
  const labelsPerSheet = a4Cols * a4Rows

  // Barcode module-width check — surfaces a warning chip on the topbar when the
  // current settings would render barcodes below the 250µm scannable minimum.
  // Computed for *label* mode (single label per page) and updated whenever the
  // template changes. The A4 sidebar has a per-cols clamp; this covers label mode.
  const colSplit       = template.columnSplitPct ?? 38
  const padMm          = template.paddingMm ?? 2
  const rightColMm     = widthMm * (colSplit / 100)
  const innerMm        = rightColMm - padMm * 2
  const barWidthMm     = Math.max(5, innerMm * ((template.barcodeWidthPct ?? 100) / 100))
  // 10 quiet + START 11 + 10×11 + CHECKSUM 11 + STOP 13 + 10 quiet = 165 modules.
  const moduleWidthMm  = barWidthMm / 165
  const moduleWarn     = moduleWidthMm < 0.25 || barWidthMm < 20

  const fillSheet = () => {
    if (items.length === 0) return
    setItems(prev => prev.map((it, i) => i === selectedIdx ? { ...it, quantity: labelsPerSheet } : it))
  }

  return (
    <div className="flex flex-col h-screen bg-slate-100 dark:bg-slate-950">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <button
          onClick={() => window.close()}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} /> Back to Inbound
        </button>
        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
        <span className="font-semibold text-slate-900 dark:text-slate-100">FNSKU Label Designer</span>
        {shipmentContext && (
          <span
            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-800"
            title={`Pre-filled from inbound shipment ${shipmentContext.reference ?? shipmentContext.id}. Click × to detach.`}
          >
            <Package size={11} /> Shipment {shipmentContext.reference ?? shipmentContext.id.slice(-8)}
            <button
              onClick={() => {
                setShipmentContext(null)
                // Remove from URL without reload so refresh doesn't re-import.
                const url = new URL(window.location.href)
                url.searchParams.delete('shipmentId')
                window.history.replaceState({}, '', url.toString())
              }}
              className="ml-0.5 hover:text-emerald-900 dark:hover:text-emerald-200"
              aria-label="Detach shipment"
            >
              <XIcon size={11} />
            </button>
          </span>
        )}
        {shipmentLoading && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Loader2 size={11} className="animate-spin" /> Loading shipment…
          </span>
        )}
        {shipmentError && (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400" title={shipmentError}>
            <AlertTriangle size={11} /> {shipmentError}
          </span>
        )}
        <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 ml-3" />
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400" title="Destination Amazon marketplace — controls which listing title appears on the label">
          <Globe size={12} />
          <span className="hidden sm:inline">Destination</span>
          <select
            value={marketplace}
            onChange={e => handleMarketplaceChange(e.target.value)}
            className="h-7 px-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            {MARKETPLACES.map(m => (
              <option key={m.code} value={m.code}>{m.label}</option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        {moduleWarn && (
          <span
            className="inline-flex items-center gap-1 h-6 px-2 rounded text-[11px] font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700"
            title={`Barcode module width ~${(moduleWidthMm * 1000).toFixed(0)}µm (recommended ≥250µm). Below this, scanners may fail. Adjust barcode width % or label size in the right panel.`}
          >
            <AlertTriangle size={12} /> Module {(moduleWidthMm * 1000).toFixed(0)}µm
          </span>
        )}
        <span className="text-xs text-slate-400">{totalLabelCount} label{totalLabelCount !== 1 ? 's' : ''} total</span>
        <span className="text-xs text-slate-400 hidden sm:inline">·</span>
        <span className="text-xs text-slate-400 hidden sm:inline">{a4Cols}×{a4Rows} = {labelsPerSheet}/sheet</span>
        {items.length > 0 && (
          <button
            onClick={fillSheet}
            title={`Set selected SKU qty to ${labelsPerSheet} to fill one A4 sheet`}
            className="text-xs h-7 px-2 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            Fill sheet
          </button>
        )}
        <div className="flex items-center gap-1.5">
          <button
            onClick={handlePrint}
            disabled={items.length === 0}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 text-sm hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Printer size={13} /> Print
          </button>
          <button
            onClick={() => handleDownloadPdf('label')}
            disabled={items.length === 0 || pdfLoading !== null}
            title="One label per page at exact label dimensions — ideal for thermal label printers"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 text-sm hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pdfLoading === 'label' ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            PDF (label)
          </button>
          <button
            onClick={() => handleDownloadPdf('a4')}
            disabled={items.length === 0 || pdfLoading !== null}
            title="Labels tiled on A4 sheets — print on a regular printer and cut"
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pdfLoading === 'a4' ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            PDF (A4)
          </button>
        </div>
      </div>

      {/* 3-panel body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: SKU panel */}
        <SkuPanel
          items={items}
          onChange={handleItemsChange}
          onFetchFnskus={(force) => fetchFnskus(items, force)}
          fetchingFnskus={fetchingFnskus}
        />

        {/* Center: preview */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 overflow-auto">
          {items.length === 0 ? (
            <div className="text-center text-slate-400">
              <p className="text-lg font-medium mb-1">No SKUs added yet</p>
              <p className="text-sm">Search for products in the left panel</p>
            </div>
          ) : (
            <>
              <LabelPreview item={items[selectedIdx] ?? items[0]} template={template} />
              {items.length > 1 && (
                <div className="flex items-center gap-3 mt-4 text-sm text-slate-600 dark:text-slate-400">
                  <button
                    onClick={() => setSelectedIdx(i => Math.max(0, i - 1))}
                    disabled={selectedIdx === 0}
                    className="h-7 w-7 flex items-center justify-center rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                  >
                    ←
                  </button>
                  <span>{selectedIdx + 1} / {items.length}</span>
                  <button
                    onClick={() => setSelectedIdx(i => Math.min(items.length - 1, i + 1))}
                    disabled={selectedIdx === items.length - 1}
                    className="h-7 w-7 flex items-center justify-center rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                  >
                    →
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: template sidebar */}
        <TemplateSidebar
          template={template}
          onChange={setTemplate}
          savedTemplates={savedTemplates}
          activeTemplateId={activeTemplateId}
          onLoad={loadTemplate}
          onSave={saveTemplate}
          onUpdate={(patch) => activeTemplateId && updateTemplate(activeTemplateId, patch)}
          onDelete={() => activeTemplateId && deleteTemplate(activeTemplateId)}
        />
      </div>
      <div ref={printRef} />
    </div>
  )
}
