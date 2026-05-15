'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Printer } from 'lucide-react'
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
  // Listing
  showListingTitle: true,
  listingTitleLines: 2,
  showCondition: true,
  condition: 'New',
  // Typography
  fontFamily: 'Arial',
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
  const [items, setItems] = useState<LabelItem[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [template, setTemplate] = useState<TemplateConfig>(DEFAULT_TEMPLATE)
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([])
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [fetchingFnskus, setFetchingFnskus] = useState(false)
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

  const fetchFnskus = useCallback(async (targetItems: LabelItem[]) => {
    const needsFnsku = targetItems.filter(it => !it.fnsku && it.sku)
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
    const w = window.open('', '_blank', 'noopener,noreferrer')
    if (!w) return
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 300)
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
        <button
          onClick={handlePrint}
          disabled={items.length === 0}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Printer size={14} /> Print All
        </button>
      </div>

      {/* 3-panel body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: SKU panel */}
        <SkuPanel
          items={items}
          onChange={handleItemsChange}
          onFetchFnskus={() => fetchFnskus(items)}
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
