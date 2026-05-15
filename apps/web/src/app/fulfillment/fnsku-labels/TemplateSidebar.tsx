'use client'

import { useState } from 'react'
import { Plus, Trash2, Save, ChevronUp, ChevronDown } from 'lucide-react'
import type { TemplateConfig, TemplateRow, SavedTemplate } from './types'

const VALUE_SOURCES: { value: TemplateRow['valueSource']; label: string }[] = [
  { value: 'productName', label: 'Product name' },
  { value: 'color',       label: 'Color attribute' },
  { value: 'size',        label: 'Size attribute' },
  { value: 'gender',      label: 'Gender attribute' },
  { value: 'sku',         label: 'SKU' },
  { value: 'asin',        label: 'ASIN (Amazon)' },
  { value: 'custom',      label: 'Custom text' },
]

const PRESETS = [
  { label: '4 × 2 in',    preset: '4x2in',   widthMm: 101.6, heightMm: 50.8 },
  { label: '4 × 3 in',    preset: '4x3in',   widthMm: 101.6, heightMm: 76.2 },
  { label: '100 × 50 mm', preset: '100x50mm',widthMm: 100,   heightMm: 50   },
  { label: '100 × 70 mm', preset: '100x70mm',widthMm: 100,   heightMm: 70   },
  { label: 'Custom',       preset: 'custom',  widthMm: 0,     heightMm: 0    },
]

const FONT_FAMILIES = [
  { value: 'Helvetica',   label: 'Helvetica (Sans)' },
  { value: 'Courier',     label: 'Courier (Mono)' },
  { value: 'Times-Roman', label: 'Times Roman (Serif)' },
]

interface Props {
  template: TemplateConfig
  onChange: (t: TemplateConfig) => void
  savedTemplates: SavedTemplate[]
  activeTemplateId: string | null
  onLoad: (t: SavedTemplate) => void
  onSave: (name: string) => Promise<void>
  onUpdate: (patch: any) => void
  onDelete: () => void
}

export function TemplateSidebar({ template, onChange, savedTemplates, activeTemplateId, onLoad, onSave, onUpdate, onDelete }: Props) {
  const [newTemplateName, setNewTemplateName] = useState('')
  const [saving, setSaving] = useState(false)
  const [showSaveInput, setShowSaveInput] = useState(false)

  const patch = (p: Partial<TemplateConfig>) => onChange({ ...template, ...p })
  const patchRow = (id: string, p: Partial<TemplateRow>) =>
    onChange({ ...template, rows: template.rows.map(r => r.id === id ? { ...r, ...p } : r) })

  const addRow = () => {
    const id = Date.now().toString()
    onChange({ ...template, rows: [...template.rows, { id, badgeText: 'FIELD', valueSource: 'custom', customValue: '', show: true, fontScale: 1.0, textTransform: 'uppercase', boldValue: true }] })
  }
  const removeRow = (id: string) => onChange({ ...template, rows: template.rows.filter(r => r.id !== id) })
  const moveRow = (id: string, dir: -1 | 1) => {
    const rows = [...template.rows]
    const idx = rows.findIndex(r => r.id === id)
    const next = idx + dir
    if (next < 0 || next >= rows.length) return
    ;[rows[idx], rows[next]] = [rows[next], rows[idx]]
    onChange({ ...template, rows })
  }

  const handleSave = async () => {
    if (!newTemplateName.trim()) return
    setSaving(true)
    try { await onSave(newTemplateName.trim()); setNewTemplateName(''); setShowSaveInput(false) }
    finally { setSaving(false) }
  }

  const activePreset = template.labelSize.preset
  const colSplit = template.columnSplitPct ?? 38
  const barcodeH = template.barcodeHeightPct ?? 32
  const padMm    = template.paddingMm ?? 2

  // Computed barcode width (mm) — mirrored from renderLabelHtml / LabelPreview
  const rightColMm = template.labelSize.widthMm * (colSplit / 100)
  const innerMm    = rightColMm - padMm * 2
  const barWidthMm = Math.max(5, innerMm * ((template.barcodeWidthPct ?? 100) / 100))
  const barcodeWarn = barWidthMm < 20

  return (
    <div className="w-80 shrink-0 flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 overflow-y-auto">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <h2 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Template</h2>
      </div>

      <div className="flex flex-col divide-y divide-slate-100 dark:divide-slate-800">

        {/* ── Saved templates ─────────────────────── */}
        <Section title="Saved templates">
          <select
            value={activeTemplateId ?? ''}
            onChange={e => { const t = savedTemplates.find(t => t.id === e.target.value); if (t) onLoad(t) }}
            className="w-full h-7 px-2 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
          >
            <option value="">(unsaved)</option>
            {savedTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="flex gap-1.5 mt-2">
            {activeTemplateId && (
              <button onClick={() => onUpdate({ config: template })}
                className="flex-1 h-6 text-xs rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1">
                <Save size={10} /> Save
              </button>
            )}
            <button onClick={() => setShowSaveInput(v => !v)}
              className="flex-1 h-6 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 inline-flex items-center justify-center gap-1">
              <Plus size={10} /> New
            </button>
            {activeTemplateId && (
              <button onClick={onDelete}
                className="h-6 w-6 text-xs rounded border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center justify-center">
                <Trash2 size={10} />
              </button>
            )}
          </div>
          {showSaveInput && (
            <div className="flex gap-1 mt-1.5">
              <input value={newTemplateName} onChange={e => setNewTemplateName(e.target.value)}
                placeholder="Template name…" onKeyDown={e => e.key === 'Enter' && handleSave()}
                className="flex-1 h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
              <button onClick={handleSave} disabled={saving || !newTemplateName.trim()}
                className="h-6 px-2 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40">
                {saving ? '…' : 'Save'}
              </button>
            </div>
          )}
        </Section>

        {/* ── Label size ──────────────────────────── */}
        <Section title="Label size">
          <div className="space-y-1">
            {PRESETS.map(p => (
              <label key={p.preset} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="size" checked={activePreset === p.preset}
                  onChange={() => p.preset === 'custom'
                    ? patch({ labelSize: { ...template.labelSize, preset: 'custom' } })
                    : patch({ labelSize: { widthMm: p.widthMm, heightMm: p.heightMm, preset: p.preset } })}
                  className="text-violet-600" />
                <span className="text-sm text-slate-700 dark:text-slate-300">{p.label}</span>
              </label>
            ))}
          </div>
          {activePreset === 'custom' && (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-1">
                <label className="text-xs text-slate-400 block">Width (mm)</label>
                <input type="number" min="20" max="300" step="0.5" value={template.labelSize.widthMm}
                  onChange={e => patch({ labelSize: { ...template.labelSize, widthMm: parseFloat(e.target.value) || 100 } })}
                  className="w-full h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none" />
              </div>
              <div className="flex-1">
                <label className="text-xs text-slate-400 block">Height (mm)</label>
                <input type="number" min="20" max="300" step="0.5" value={template.labelSize.heightMm}
                  onChange={e => patch({ labelSize: { ...template.labelSize, heightMm: parseFloat(e.target.value) || 70 } })}
                  className="w-full h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none" />
              </div>
            </div>
          )}
        </Section>

        {/* ── Layout ──────────────────────────────── */}
        <Section title="Layout">
          <SliderRow label="Right column width" value={colSplit} min={15} max={55} unit="%"
            onChange={v => patch({ columnSplitPct: v })} />
          <div className="flex items-center gap-3 mt-2">
            <label className="text-xs text-slate-400 whitespace-nowrap">Padding (mm)</label>
            <input type="number" min={0} max={5} step={0.5} value={padMm}
              onChange={e => patch({ paddingMm: parseFloat(e.target.value) || 0 })}
              className="w-16 h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none" />
            <Checkbox label="Divider line" checked={template.showColumnDivider ?? true}
              onChange={v => patch({ showColumnDivider: v })} />
          </div>
        </Section>

        {/* ── Typography ──────────────────────────── */}
        <Section title="Typography">
          <label className="text-xs text-slate-400 block mb-0.5">Font family</label>
          <select value={template.fontFamily ?? 'Arial'}
            onChange={e => patch({ fontFamily: e.target.value })}
            className="w-full h-7 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 mb-2">
            {FONT_FAMILIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <SliderRow label="Badge size" value={template.badgeFontScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
            onChange={v => patch({ badgeFontScale: v })} />
          <SliderRow label="Value size" value={template.valueFontScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
            onChange={v => patch({ valueFontScale: v })} />
        </Section>

        {/* ── Field rows ──────────────────────────── */}
        <Section title="Field rows">
          <div className="space-y-2">
            {template.rows.map((row, idx) => (
              <div key={row.id} className="rounded border border-slate-200 dark:border-slate-700 p-2">
                <div className="flex items-center gap-1 mb-1.5">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => moveRow(row.id, -1)} disabled={idx === 0}
                      className="h-3.5 w-3.5 flex items-center justify-center text-slate-400 hover:text-slate-600 disabled:opacity-20">
                      <ChevronUp size={10} />
                    </button>
                    <button onClick={() => moveRow(row.id, 1)} disabled={idx === template.rows.length - 1}
                      className="h-3.5 w-3.5 flex items-center justify-center text-slate-400 hover:text-slate-600 disabled:opacity-20">
                      <ChevronDown size={10} />
                    </button>
                  </div>
                  <input value={row.badgeText} onChange={e => patchRow(row.id, { badgeText: e.target.value })}
                    placeholder="Badge" className="flex-1 h-6 px-2 text-xs uppercase font-bold rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                  <input type="checkbox" checked={row.show} onChange={e => patchRow(row.id, { show: e.target.checked })}
                    className="text-violet-600" title="Show row" />
                  <button onClick={() => removeRow(row.id)} className="text-slate-400 hover:text-red-500">
                    <XIcon size={12} />
                  </button>
                </div>
                <select value={row.valueSource}
                  onChange={e => patchRow(row.id, { valueSource: e.target.value as TemplateRow['valueSource'] })}
                  className="w-full h-6 px-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 mb-1">
                  {VALUE_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                {row.valueSource === 'custom' && (
                  <input value={row.customValue} onChange={e => patchRow(row.id, { customValue: e.target.value })}
                    placeholder="Custom value…"
                    className="w-full h-6 px-2 text-xs mb-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                )}
                {/* Per-row controls */}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-slate-400 shrink-0">Size ×{(row.fontScale ?? 1).toFixed(2)}</span>
                  <input type="range" min={0.5} max={2.0} step={0.05} value={row.fontScale ?? 1}
                    onChange={e => patchRow(row.id, { fontScale: parseFloat(e.target.value) })}
                    className="flex-1 accent-violet-500 h-1" />
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] text-slate-400">Transform:</span>
                  {(['uppercase', 'none', 'capitalize'] as const).map(tx => (
                    <button key={tx} onClick={() => patchRow(row.id, { textTransform: tx })}
                      className={`h-5 px-1.5 text-[10px] rounded border transition-colors ${(row.textTransform ?? 'uppercase') === tx ? 'bg-violet-600 text-white border-violet-600' : 'border-slate-300 dark:border-slate-600 text-slate-500 hover:border-violet-400'}`}>
                      {tx === 'uppercase' ? 'AA' : tx === 'none' ? 'aa' : 'Aa'}
                    </button>
                  ))}
                  <label className="ml-auto flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                    <input type="checkbox" checked={row.boldValue !== false}
                      onChange={e => patchRow(row.id, { boldValue: e.target.checked })}
                      className="text-violet-600" /> Bold
                  </label>
                </div>
              </div>
            ))}
          </div>
          <button onClick={addRow}
            className="mt-2 w-full h-7 text-xs rounded border border-dashed border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20 inline-flex items-center justify-center gap-1">
            <Plus size={11} /> Add row
          </button>
        </Section>

        {/* ── Display options ─────────────────────── */}
        <Section title="Display options">
          <div className="space-y-1.5">
            <Checkbox label="Show logo" checked={template.showLogo} onChange={v => patch({ showLogo: v })} />
            <div className="flex items-center gap-2">
              <Checkbox label="Show size box" checked={template.showSizeBox} onChange={v => patch({ showSizeBox: v })} />
              {template.showSizeBox && (
                <input value={template.sizeBoxLabel ?? 'SIZE'} onChange={e => patch({ sizeBoxLabel: e.target.value })}
                  placeholder="SIZE" maxLength={8}
                  className="flex-1 h-5 px-1.5 text-xs uppercase font-bold rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
              )}
            </div>
            {template.showSizeBox && (
              <div className="ml-1 space-y-0.5">
                <SliderRow label="Size value scale" value={template.sizeValueScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
                  onChange={v => patch({ sizeValueScale: v })} />
                <SliderRow label="Size label scale" value={template.sizeHeaderScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
                  onChange={v => patch({ sizeHeaderScale: v })} />
              </div>
            )}
            <div className="flex items-center gap-2">
              <Checkbox label="Show listing title" checked={template.showListingTitle} onChange={v => patch({ showListingTitle: v })} />
              {template.showListingTitle && (
                <select value={template.listingTitleLines ?? 2}
                  onChange={e => patch({ listingTitleLines: parseInt(e.target.value) })}
                  className="ml-auto h-5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800">
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} line{n > 1 ? 's' : ''}</option>)}
                </select>
              )}
            </div>
            {!template.showListingTitle && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 ml-5">Required by Amazon FBA</p>
            )}
            {template.showListingTitle && (
              <div className="ml-1">
                <SliderRow label="Title size" value={template.listingTitleScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
                  onChange={v => patch({ listingTitleScale: v })} />
              </div>
            )}
            <Checkbox label="Show condition" checked={template.showCondition} onChange={v => patch({ showCondition: v })} />
            {!template.showCondition && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 ml-5">Required by Amazon FBA</p>
            )}
            {template.showCondition && (
              <div className="ml-1">
                <SliderRow label="Condition size" value={template.conditionScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
                  onChange={v => patch({ conditionScale: v })} />
              </div>
            )}
          </div>
          {template.showCondition && (
            <input value={template.condition} onChange={e => patch({ condition: e.target.value })}
              className="w-full h-6 px-2 text-xs mt-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
          )}
          {template.showColumnDivider === undefined || true ? null : null}
        </Section>

        {/* ── Barcode ─────────────────────────────── */}
        <Section title="Barcode">
          <SliderRow label="Height" value={barcodeH} min={10} max={55} unit="%" onChange={v => patch({ barcodeHeightPct: v })} />
          <SliderRow label="Width"  value={template.barcodeWidthPct ?? 100} min={20} max={100} unit="%" onChange={v => patch({ barcodeWidthPct: v })} />
          <SliderRow label="FNSKU text" value={template.fnskuTextScale ?? 1} min={0.5} max={2.0} step={0.05} unit="×"
            onChange={v => patch({ fnskuTextScale: v })} />
          <p className="text-[10px] text-slate-400 mt-1">
            Effective width: ~{barWidthMm.toFixed(1)}mm.
          </p>
          {barcodeWarn && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
              Width {barWidthMm.toFixed(1)}mm is below the 20mm minimum for reliable scanning.
            </p>
          )}
        </Section>

        {/* ── Sheet layout (A4 mode) ─────────────── */}
        <Section title="A4 sheet layout">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs text-slate-500 shrink-0 w-28">Columns</span>
            <input
              type="number" min={0} max={10} step={1}
              value={template.sheetCols ?? ''}
              placeholder="auto"
              onChange={e => {
                const v = e.target.value === '' ? undefined : Math.max(1, parseInt(e.target.value) || 1)
                patch({ sheetCols: v })
              }}
              className="w-16 h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none"
            />
            <span className="text-xs text-slate-400">(blank = auto)</span>
          </div>
          <SliderRow label="Sheet margin" value={template.sheetMarginMm ?? 5} min={0} max={20} step={0.5} unit="mm"
            onChange={v => patch({ sheetMarginMm: v })} />
          <SliderRow label="Label gap" value={template.sheetGapMm ?? 2} min={0} max={10} step={0.5} unit="mm"
            onChange={v => patch({ sheetGapMm: v })} />
        </Section>

        {/* ── Logo URL ────────────────────────────── */}
        {template.showLogo && (
          <Section title="Logo">
            <input value={template.logoUrl} onChange={e => patch({ logoUrl: e.target.value })}
              placeholder="https://…/logo.png"
              className="w-full h-7 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500" />
            <p className="text-xs text-slate-400 mt-1 mb-2">Direct image URL. Leave blank for placeholder.</p>
            <SliderRow label="Logo height" value={template.logoHeightPct ?? 22} min={10} max={40} step={1} unit="% h"
              onChange={v => patch({ logoHeightPct: v })} />
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-2">{title}</h3>
      {children}
    </div>
  )
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-700 dark:text-slate-300">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="text-violet-600 rounded" />
      {label}
    </label>
  )
}

function SliderRow({ label, value, min, max, step = 1, unit, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit: string; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2 mb-1">
      <span className="text-xs text-slate-500 shrink-0 w-28">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-violet-500 h-1" />
      <span className="text-xs text-slate-500 tabular-nums w-10 text-right">{Number.isInteger(step) ? value : value.toFixed(2)}{unit}</span>
    </div>
  )
}

function XIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
