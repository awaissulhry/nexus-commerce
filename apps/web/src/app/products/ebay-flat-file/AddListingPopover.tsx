'use client'

import { useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { TagInput } from '@/design-system/primitives/TagInput'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Combobox } from '@/design-system/components/Combobox'
import type { BaseRow } from '@/components/flat-file/FlatFileGrid.types'
import type { EbayRow } from './EbayFlatFileClient'
import { generateVariantRowsUnderParent } from './addVariantRows'

// ── Predefined axes with value suggestions ───────────────────────────────────

const PRESET_AXES: Array<{ name: string; suggestions: string[] }> = [
  { name: 'Color',    suggestions: ['Black', 'White', 'Blue', 'Red', 'Yellow', 'Green', 'Grey', 'Brown', 'Navy', 'Orange'] },
  { name: 'Size',     suggestions: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'] },
  { name: 'Gender',   suggestions: ['Men', 'Women', 'Unisex', 'Kids'] },
  { name: 'Material', suggestions: ['Leather', 'Textile', 'Mesh', 'Synthetic', 'Denim'] },
  { name: 'Style',    suggestions: [] },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function cartesian<T>(arrays: T[][]): T[][] {
  if (!arrays.length) return [[]]
  return arrays.reduce<T[][]>((acc, arr) => acc.flatMap((prev) => arr.map((v) => [...prev, v])), [[]])
}

function buildDefaultTemplate(parentSku: string, axes: string[]): string {
  const tokens = axes.map((a) => `{${a}}`).join('-')
  return parentSku ? `${parentSku}-${tokens}` : tokens
}

function renderTemplate(template: string, parentSku: string, values: Record<string, string>): string {
  let result = template.replace(/\{PARENT\}/gi, parentSku)
  for (const [axis, val] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${axis}\\}`, 'gi'), val)
  }
  return result
}

// ── Main component ────────────────────────────────────────────────────────────

interface ExistingParent {
  id: string
  sku: string
  variationTheme?: string
}

interface Props {
  /** Category-sourced variant-eligible axis names (injected from the loaded category schema) */
  categoryAxisNames?: string[]
  /** Parent rows already in the grid — enables "Add to existing family" mode */
  existingParents?: ExistingParent[]
  onConfirm: (rows: BaseRow[]) => void
  onClose: () => void
}

export function AddListingPopover({ categoryAxisNames = [], existingParents, onConfirm, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  // ── Form state ──────────────────────────────────────────────────────────────
  const [familyMode, setFamilyMode] = useState<'new' | 'existing'>('new')
  const [targetParentId, setTargetParentId] = useState<string>('')
  const [listingType, setListingType] = useState<'single' | 'variation'>('variation')
  const [parentSku, setParentSku] = useState('')

  // Merge preset axes with category-sourced ones (deduplicated by name)
  const allPresetNames = PRESET_AXES.map((a) => a.name)
  const categoryOnlyAxes = categoryAxisNames.filter((n) => !allPresetNames.includes(n))
  const allAxes: Array<{ name: string; suggestions: string[] }> = [
    ...PRESET_AXES,
    ...categoryOnlyAxes.map((n) => ({ name: n, suggestions: [] })),
  ]

  const [selectedAxes, setSelectedAxes] = useState<string[]>(['Color', 'Size'])
  const [axisValues, setAxisValues] = useState<Record<string, string[]>>({})
  const [customAxisName, setCustomAxisName] = useState('')
  const [customAxes, setCustomAxes] = useState<string[]>([])
  const [skuTemplate, setSkuTemplate] = useState('')
  const [templateEdited, setTemplateEdited] = useState(false)

  // Auto-update template when axes or parentSku change, unless user edited it manually
  useEffect(() => {
    if (!templateEdited) {
      setSkuTemplate(buildDefaultTemplate(parentSku, selectedAxes))
    }
  }, [selectedAxes, parentSku, templateEdited])

  const resetTemplate = () => {
    setSkuTemplate(buildDefaultTemplate(parentSku, selectedAxes))
    setTemplateEdited(false)
  }

  // When a parent is chosen in 'existing' mode, seed parentSku + selectedAxes from that parent
  useEffect(() => {
    if (familyMode !== 'existing' || !targetParentId) return
    const parent = existingParents?.find((p) => p.id === targetParentId)
    if (!parent) return
    setParentSku(parent.sku)
    const axes = parent.variationTheme
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
    if (axes.length) setSelectedAxes(axes)
    setTemplateEdited(false) // let the template effect rebuild from the new parentSku/axes
  }, [familyMode, targetParentId, existingParents])

  // ── Derived preview ─────────────────────────────────────────────────────────
  const activeAxisValues = selectedAxes.map((a) => axisValues[a] ?? []).filter((v) => v.length > 0)
  // In 'existing' mode we always compute combinations (axes are fixed by the parent)
  const combinations = (familyMode === 'existing' || listingType === 'variation') ? cartesian(activeAxisValues) : []
  const variantCount = combinations.length

  // Build a sample SKU from the first combination for preview
  const sampleValues = selectedAxes.reduce<Record<string, string>>((acc, axis) => {
    const vals = axisValues[axis] ?? []
    if (vals[0]) acc[axis] = vals[0]
    return acc
  }, {})
  const sampleSku = parentSku
    ? renderTemplate(skuTemplate, parentSku, { ...sampleValues, PARENT: parentSku })
    : ''

  // ── Row generation ──────────────────────────────────────────────────────────
  function generateRows(): BaseRow[] {
    // 'existing' — only variant rows under the chosen parent; no parent row generated here
    if (familyMode === 'existing') {
      return generateVariantRowsUnderParent({
        parentId: targetParentId,
        axes: selectedAxes,
        axisValues,
        skuTemplate,
        parentSku,
      }) as BaseRow[]
    }

    const ts = Date.now()

    if (listingType === 'single') {
      const row: EbayRow = {
        _rowId: `new-${ts}-parent`,
        _isNew: true,
        _dirty: true,
        _status: 'idle',
        sku: parentSku,
        _isParent: undefined, // standalone (not part of a variation family)
      }
      return [row]
    }

    const parentRowId = `new-${ts}-parent`
    const parentRow: EbayRow = {
      _rowId: parentRowId,
      _isNew: true,
      _dirty: true,
      _status: 'idle',
      sku: parentSku,
      _isParent: true,
      variation_theme: selectedAxes.join(','),
    } as EbayRow & { variation_theme: string }

    const variantRows: EbayRow[] = combinations.map((combo, i) => {
      const valueMap: Record<string, string> = {}
      selectedAxes.forEach((axis, j) => { valueMap[axis] = combo[j] ?? '' })
      const varSku = renderTemplate(skuTemplate, parentSku, { ...valueMap, PARENT: parentSku })
      const row: EbayRow = {
        _rowId: `new-${ts}-var-${i}`,
        _isNew: true,
        _dirty: true,
        _status: 'idle',
        sku: varSku,
        _isParent: false,
        platformProductId: parentRowId,
        // carry axis values as aspects (flat-file will map them to the right columns)
        ...Object.fromEntries(
          selectedAxes.map((axis) => [`aspect_${axis.toLowerCase()}`, valueMap[axis]]),
        ),
      }
      return row
    })

    return [parentRow, ...variantRows]
  }

  const canConfirm = familyMode === 'existing'
    ? targetParentId.trim().length > 0 && variantCount > 0 && selectedAxes.length > 0
    : parentSku.trim().length > 0 && (listingType === 'single' || (variantCount > 0 && selectedAxes.length > 0))

  // ── Axis management ─────────────────────────────────────────────────────────
  function toggleAxis(name: string) {
    setSelectedAxes((prev) =>
      prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name],
    )
  }

  function addCustomAxis() {
    const name = customAxisName.trim()
    if (!name || allAxes.some((a) => a.name === name)) return
    setCustomAxes((prev) => [...prev, name])
    setSelectedAxes((prev) => [...prev, name])
    setCustomAxisName('')
  }

  const displayAxes = [...allAxes, ...customAxes.map((n) => ({ name: n, suggestions: [] }))]

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      ref={panelRef}
      className="absolute left-0 top-full mt-1 z-[60] w-[480px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Add Listing</div>
          <div className="text-xs text-slate-400">Generates parent + variant rows in the grid</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-4 max-h-[70vh] overflow-y-auto">

        {/* ── Family mode toggle (only when there are existing parents) ─────── */}
        {(existingParents?.length ?? 0) > 0 && (
          <div>
            <SegmentedControl
              size="sm"
              value={familyMode}
              onChange={(v) => {
                setFamilyMode(v as 'new' | 'existing')
                if (v === 'new') setTargetParentId('')
              }}
              options={[
                { value: 'new',      label: 'New family' },
                { value: 'existing', label: 'Add to existing family' },
              ]}
            />
          </div>
        )}

        {/* ── Existing-family parent picker ─────────────────────────────────── */}
        {familyMode === 'existing' && (
          <div>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Parent listing</div>
            <Combobox
              options={(existingParents ?? []).map((p) => ({ value: p.id, label: p.sku }))}
              value={targetParentId || undefined}
              onChange={(id) => setTargetParentId(id)}
              placeholder="Search by parent SKU…"
            />
          </div>
        )}

        {/* ── Listing type (hidden in existing mode — always variation there) ─ */}
        {familyMode === 'new' && (
        <div>
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Listing type</div>
          <div className="grid grid-cols-2 gap-2">
            {([
              ['single',    'Single item',      'One SKU, no size/color options'],
              ['variation', 'Variation listing', 'Multiple SKUs — size, color, other axes'],
            ] as const).map(([val, label, desc]) => (
              <label key={val}
                className={cn(
                  'flex flex-col gap-0.5 cursor-pointer rounded-lg border px-3 py-2 transition-colors',
                  listingType === val
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                <input type="radio" name="listing-type" value={val}
                  checked={listingType === val}
                  onChange={() => setListingType(val)}
                  className="sr-only" />
                <span className={cn('text-xs font-semibold', listingType === val ? 'text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-200')}>{label}</span>
                <span className="text-[10px] text-slate-400 leading-snug">{desc}</span>
              </label>
            ))}
          </div>
        </div>
        )}

        {/* ── Variation axes ───────────────────────────────────────────────── */}
        {(familyMode === 'new' ? listingType === 'variation' : !!targetParentId) && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Variation axes</span>
              {familyMode === 'existing' && (
                <span className="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 rounded px-1.5 py-0.5">
                  locked — set by parent
                </span>
              )}
            </div>
            <div className="space-y-2">
              {familyMode === 'existing'
                ? /* Locked axis display — values still editable; axis selection is read-only */
                  selectedAxes.map((name) => {
                    const preset = PRESET_AXES.find((p) => p.name === name)
                    return (
                      <div key={name}
                        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50"
                      >
                        <div className="flex items-center gap-2 px-3 py-2">
                          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{name}</span>
                          {(axisValues[name] ?? []).length > 0 && (
                            <span className="ml-auto text-[10px] text-slate-400">
                              {(axisValues[name] ?? []).length} value{(axisValues[name] ?? []).length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                        <div className="px-3 pb-2">
                          <TagInput
                            value={axisValues[name] ?? []}
                            onChange={(tags) => setAxisValues((prev) => ({ ...prev, [name]: tags }))}
                            suggestions={preset?.suggestions ?? []}
                            placeholder={`Add ${name.toLowerCase()} values… (Enter or comma to confirm)`}
                            aria-label={`${name} values`}
                          />
                        </div>
                      </div>
                    )
                  })
                : /* New-family mode — editable axes with checkboxes */
                  displayAxes.map(({ name, suggestions }) => (
                    <div key={name}
                      className={cn(
                        'rounded-lg border transition-colors',
                        selectedAxes.includes(name)
                          ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'
                          : 'border-transparent',
                      )}
                    >
                      <label className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={selectedAxes.includes(name)}
                          onChange={() => toggleAxis(name)}
                          className="w-3.5 h-3.5 rounded accent-blue-600"
                        />
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{name}</span>
                        {selectedAxes.includes(name) && (axisValues[name] ?? []).length > 0 && (
                          <span className="ml-auto text-[10px] text-slate-400">
                            {(axisValues[name] ?? []).length} value{(axisValues[name] ?? []).length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </label>
                      {selectedAxes.includes(name) && (
                        <div className="px-3 pb-2">
                          <TagInput
                            value={axisValues[name] ?? []}
                            onChange={(tags) => setAxisValues((prev) => ({ ...prev, [name]: tags }))}
                            suggestions={suggestions}
                            placeholder={`Add ${name.toLowerCase()} values… (Enter or comma to confirm)`}
                            aria-label={`${name} values`}
                          />
                        </div>
                      )}
                    </div>
                  ))
              }

              {/* Custom axis input — new-family mode only */}
              {familyMode === 'new' && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={customAxisName}
                    onChange={(e) => setCustomAxisName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addCustomAxis() }}
                    placeholder="+ Add custom axis…"
                    className="flex-1 text-xs bg-transparent border border-dashed border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-600 dark:text-slate-400 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  {customAxisName.trim() && (
                    <Button size="sm" variant="ghost" onClick={addCustomAxis}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SKU builder — hidden in 'existing' mode (parentSku derived from selected parent) ── */}
        {familyMode === 'new' && (
        <div>
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">
            {listingType === 'variation' ? 'Parent SKU' : 'SKU'}
          </div>
          <input
            type="text"
            value={parentSku}
            onChange={(e) => setParentSku(e.target.value.toUpperCase())}
            placeholder="e.g. GALE-JACKET"
            className="w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        )}

        {(familyMode === 'new' ? listingType === 'variation' : !!targetParentId) && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">Variant SKU template</div>
              {templateEdited && (
                <button
                  onClick={resetTemplate}
                  className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-blue-500 transition-colors"
                >
                  <RefreshCw className="w-2.5 h-2.5" />Reset to default
                </button>
              )}
            </div>
            <input
              type="text"
              value={skuTemplate}
              onChange={(e) => { setSkuTemplate(e.target.value); setTemplateEdited(true) }}
              placeholder="e.g. {PARENT}-{Color}-MEN-{Size}"
              className="w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="mt-1.5 flex flex-wrap gap-1">
              <span className="text-[10px] text-slate-400">Tokens:</span>
              {['{PARENT}', ...selectedAxes.map((a) => `{${a}}`)].map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => { setSkuTemplate((t) => t + token); setTemplateEdited(true) }}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
                >
                  {token}
                </button>
              ))}
            </div>
            {sampleSku && (
              <div className="mt-2 text-[10px] text-slate-400">
                Preview: <span className="font-mono text-slate-600 dark:text-slate-300">{sampleSku}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-400">
          {familyMode === 'existing' && !targetParentId && (
            <span>Select a parent listing above</span>
          )}
          {familyMode === 'existing' && targetParentId && selectedAxes.length === 0 && (
            <span className="text-amber-500">Parent has no variation theme — cannot add variants</span>
          )}
          {familyMode === 'existing' && targetParentId && selectedAxes.length > 0 && variantCount > 0 && (
            <span><strong className="text-slate-600 dark:text-slate-300">{variantCount}</strong> variant{variantCount !== 1 ? 's' : ''} added under {parentSku}</span>
          )}
          {familyMode === 'existing' && targetParentId && selectedAxes.length > 0 && variantCount === 0 && (
            <span className="text-amber-500">Add values to the selected axes</span>
          )}
          {familyMode === 'new' && listingType === 'single' && parentSku && (
            <span>1 row will be added</span>
          )}
          {familyMode === 'new' && listingType === 'variation' && variantCount > 0 && (
            <span>1 parent + <strong className="text-slate-600 dark:text-slate-300">{variantCount}</strong> variant{variantCount !== 1 ? 's' : ''}</span>
          )}
          {familyMode === 'new' && listingType === 'variation' && variantCount === 0 && selectedAxes.length > 0 && (
            <span className="text-amber-500">Add values to the selected axes</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!canConfirm} onClick={() => { onConfirm(generateRows()); onClose() }}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add rows
          </Button>
        </div>
      </div>
    </div>
  )
}
