'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Printer, FileDown, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { SkuPanel } from './SkuPanel'
import { LabelPreview } from './LabelPreview'
import { TemplateSidebar } from './TemplateSidebar'
import { buildPrintHtml } from './print-utils'
import type { LabelItem, TemplateConfig, SavedTemplate } from './types'

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
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [template, setTemplate] = useState<TemplateConfig>(DEFAULT_TEMPLATE)
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [fetchingFnskus, setFetchingFnskus] = useState(false)
  const [pdfLoading, setPdfLoading] = useState<'label' | 'a4' | null>(null)
  const printRef = useRef<HTMLDivElement>(null)

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

  const fetchFnskus = useCallback(async (targetItems: LabelItem[], force = false) => {
    const needsFnsku = force
      ? targetItems.filter(it => it.sku)
      : targetItems.filter(it => !it.fnsku && it.sku)
    if (needsFnsku.length === 0) return
    setFetchingFnskus(true)
    // Mark them as loading
    setItems(prev => prev.map(it =>
      needsFnsku.some(n => n.sku === it.sku) ? { ...it, fnskuLoading: true } : it,
    ))
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fnsku/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: needsFnsku.map(it => it.sku) }),
      })
      const data = await res.json()
      const results: any[] = data?.results ?? []
      setItems(prev => prev.map(it => {
        const hit = results.find((r: any) => r.sku === it.sku)
        if (!hit) return { ...it, fnskuLoading: false }
        return {
          ...it,
          fnskuLoading: false,
          fnsku: hit.fnsku ?? it.fnsku,
          asin: it.asin ?? hit.asin ?? null,
          fnskuError: hit.error,
          productName: it.productName ?? hit.productName,
          listingTitle: it.listingTitle ?? hit.listingTitle,
          variationAttributes: Object.keys(it.variationAttributes).length > 0
            ? it.variationAttributes
            : (hit.variationAttributes ?? {}),
          imageUrl: it.imageUrl ?? hit.imageUrl,
        }
      }))
    } catch {
      setItems(prev => prev.map(it => ({ ...it, fnskuLoading: false })))
    } finally {
      setFetchingFnskus(false)
    }
  }, [])

  const handleItemsChange = useCallback((next: LabelItem[]) => {
    setItems(next)
    setSelectedIdx(i => Math.min(i, Math.max(0, next.length - 1)))
    try { localStorage.setItem('fnsku-label-items', JSON.stringify(next)) } catch {}
    // Auto-fetch FNSKUs for newly added items
    const newOnes = next.filter(it => !it.fnsku && !it.fnskuLoading && it.sku)
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
        <div className="flex-1" />
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
