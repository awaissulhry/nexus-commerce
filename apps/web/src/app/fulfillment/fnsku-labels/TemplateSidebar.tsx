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
  { value: 'custom',      label: 'Custom text' },
]

const PRESETS = [
  { label: '4 × 2 in', preset: '4x2in', widthMm: 101.6, heightMm: 50.8 },
  { label: '4 × 3 in', preset: '4x3in', widthMm: 101.6, heightMm: 76.2 },
  { label: '100 × 50 mm', preset: '100x50mm', widthMm: 100, heightMm: 50 },
  { label: '100 × 70 mm', preset: '100x70mm', widthMm: 100, heightMm: 70 },
  { label: 'Custom', preset: 'custom', widthMm: 0, heightMm: 0 },
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

  const patchRow = (id: string, p: Partial<TemplateRow>) => {
    onChange({ ...template, rows: template.rows.map(r => r.id === id ? { ...r, ...p } : r) })
  }

  const addRow = () => {
    const id = Date.now().toString()
    onChange({ ...template, rows: [...template.rows, { id, badgeText: 'FIELD', valueSource: 'custom', customValue: '', show: true }] })
  }

  const removeRow = (id: string) => {
    onChange({ ...template, rows: template.rows.filter(r => r.id !== id) })
  }

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
    try {
      await onSave(newTemplateName.trim())
      setNewTemplateName('')
      setShowSaveInput(false)
    } finally { setSaving(false) }
  }

  const handleUpdateCurrent = () => {
    if (!activeTemplateId) return
    onUpdate({ config: template })
  }

  const activePreset = template.labelSize.preset

  return (
    <div className="w-72 shrink-0 flex flex-col bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-800 overflow-y-auto">
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <h2 className="font-semibold text-sm text-slate-800 dark:text-slate-200">Template</h2>
      </div>

      <div className="flex flex-col gap-0 divide-y divide-slate-100 dark:divide-slate-800">

        {/* ── Template picker ───────────────────────────── */}
        <Section title="Saved templates">
          <select
            value={activeTemplateId ?? ''}
            onChange={e => {
              const t = savedTemplates.find(t => t.id === e.target.value)
              if (t) onLoad(t)
            }}
            className="w-full h-7 px-2 text-sm rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
          >
            <option value="">(unsaved)</option>
            {savedTemplates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <div className="flex gap-1.5 mt-2">
            {activeTemplateId && (
              <button
                onClick={handleUpdateCurrent}
                className="flex-1 h-6 text-xs rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1"
              >
                <Save size={10} /> Save
              </button>
            )}
            <button
              onClick={() => setShowSaveInput(v => !v)}
              className="flex-1 h-6 text-xs rounded border border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-violet-950/30 inline-flex items-center justify-center gap-1"
            >
              <Plus size={10} /> New
            </button>
            {activeTemplateId && (
              <button
                onClick={onDelete}
                className="h-6 w-6 text-xs rounded border border-red-200 dark:border-red-900 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center justify-center"
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
          {showSaveInput && (
            <div className="flex gap-1 mt-1.5">
              <input
                value={newTemplateName}
                onChange={e => setNewTemplateName(e.target.value)}
                placeholder="Template name…"
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                className="flex-1 h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
              <button
                onClick={handleSave}
                disabled={saving || !newTemplateName.trim()}
                className="h-6 px-2 text-xs rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
              >
                {saving ? '…' : 'Save'}
              </button>
            </div>
          )}
        </Section>

        {/* ── Label size ────────────────────────────────── */}
        <Section title="Label size">
          <div className="space-y-1">
            {PRESETS.map(p => (
              <label key={p.preset} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="size"
                  checked={activePreset === p.preset}
                  onChange={() => {
                    if (p.preset === 'custom') {
                      patch({ labelSize: { ...template.labelSize, preset: 'custom' } })
                    } else {
                      patch({ labelSize: { widthMm: p.widthMm, heightMm: p.heightMm, preset: p.preset } })
                    }
                  }}
                  className="text-violet-600"
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">{p.label}</span>
              </label>
            ))}
          </div>
          {activePreset === 'custom' && (
            <div className="flex items-center gap-2 mt-2">
              <div className="flex-1">
                <label className="text-xs text-slate-400 block">Width (mm)</label>
                <input
                  type="number" min="20" max="300" step="0.5"
                  value={template.labelSize.widthMm}
                  onChange={e => patch({ labelSize: { ...template.labelSize, widthMm: parseFloat(e.target.value) || 100 } })}
                  className="w-full h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="text-xs text-slate-400 block">Height (mm)</label>
                <input
                  type="number" min="20" max="300" step="0.5"
                  value={template.labelSize.heightMm}
                  onChange={e => patch({ labelSize: { ...template.labelSize, heightMm: parseFloat(e.target.value) || 70 } })}
                  className="w-full h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none"
                />
              </div>
            </div>
          )}
        </Section>

        {/* ── Field rows ────────────────────────────────── */}
        <Section title="Field rows">
          <div className="space-y-2">
            {template.rows.map((row, idx) => (
              <div key={row.id} className="rounded border border-slate-200 dark:border-slate-700 p-2">
                <div className="flex items-center gap-1 mb-1.5">
                  {/* Move up/down */}
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => moveRow(row.id, -1)} disabled={idx === 0} className="h-3.5 w-3.5 flex items-center justify-center text-slate-400 hover:text-slate-600 disabled:opacity-20">
                      <ChevronUp size={10} />
                    </button>
                    <button onClick={() => moveRow(row.id, 1)} disabled={idx === template.rows.length - 1} className="h-3.5 w-3.5 flex items-center justify-center text-slate-400 hover:text-slate-600 disabled:opacity-20">
                      <ChevronDown size={10} />
                    </button>
                  </div>
                  {/* Badge text */}
                  <input
                    value={row.badgeText}
                    onChange={e => patchRow(row.id, { badgeText: e.target.value })}
                    placeholder="Badge"
                    className="flex-1 h-6 px-2 text-xs uppercase font-bold rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  {/* Show toggle */}
                  <input
                    type="checkbox"
                    checked={row.show}
                    onChange={e => patchRow(row.id, { show: e.target.checked })}
                    className="text-violet-600"
                    title="Show row"
                  />
                  {/* Remove */}
                  <button onClick={() => removeRow(row.id)} className="text-slate-400 hover:text-red-500">
                    <X size={12} />
                  </button>
                </div>
                {/* Value source */}
                <select
                  value={row.valueSource}
                  onChange={e => patchRow(row.id, { valueSource: e.target.value as TemplateRow['valueSource'] })}
                  className="w-full h-6 px-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                >
                  {VALUE_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                {row.valueSource === 'custom' && (
                  <input
                    value={row.customValue}
                    onChange={e => patchRow(row.id, { customValue: e.target.value })}
                    placeholder="Custom value…"
                    className="w-full h-6 px-2 text-xs mt-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                )}
              </div>
            ))}
          </div>
          <button
            onClick={addRow}
            className="mt-2 w-full h-7 text-xs rounded border border-dashed border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/20 inline-flex items-center justify-center gap-1"
          >
            <Plus size={11} /> Add row
          </button>
        </Section>

        {/* ── Display options ───────────────────────────── */}
        <Section title="Display options">
          <div className="space-y-1.5">
            <Checkbox label="Show logo" checked={template.showLogo} onChange={v => patch({ showLogo: v })} />
            <Checkbox label="Show size box" checked={template.showSizeBox} onChange={v => patch({ showSizeBox: v })} />
            <Checkbox label="Show listing title" checked={template.showListingTitle} onChange={v => patch({ showListingTitle: v })} />
            <Checkbox label="Show condition" checked={template.showCondition} onChange={v => patch({ showCondition: v })} />
          </div>
          {template.showCondition && (
            <div className="mt-2">
              <label className="text-xs text-slate-400 block mb-0.5">Condition text</label>
              <input
                value={template.condition}
                onChange={e => patch({ condition: e.target.value })}
                className="w-full h-6 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
          )}
        </Section>

        {/* ── Logo URL ─────────────────────────────────── */}
        {template.showLogo && (
          <Section title="Logo URL">
            <input
              value={template.logoUrl}
              onChange={e => patch({ logoUrl: e.target.value })}
              placeholder="https://…/logo.png"
              className="w-full h-7 px-2 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
            <p className="text-xs text-slate-400 mt-1">Paste a direct image URL. Leave blank to show a placeholder.</p>
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
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="text-violet-600 rounded"
      />
      {label}
    </label>
  )
}

function X({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}
