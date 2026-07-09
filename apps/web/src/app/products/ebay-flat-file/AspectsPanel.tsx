'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/design-system/components/Drawer'
import type { BaseRow } from '@/components/flat-file/FlatFileGrid.types'
import type { EbayColumnGroup } from './ebay-columns'

interface Props {
  open: boolean
  row: BaseRow | null
  categoryGroup: EbayColumnGroup | null
  onSave: (rowId: string, values: Record<string, unknown>) => void
  onClose: () => void
}

/**
 * Right-side Drawer for editing Item Specifics (category aspects) for a single
 * row. Groups aspects by guidance level: Required → Recommended → Optional.
 * EFF.4 — replaces free-text cell entry for the Item Specifics group.
 */
export function AspectsPanel({ open, row, categoryGroup, onSave, onClose }: Props) {
  const [values, setValues] = useState<Record<string, string>>({})

  // Reset draft values whenever the row or category changes
  useEffect(() => {
    if (!row || !categoryGroup) return
    const draft: Record<string, string> = {}
    for (const col of categoryGroup.columns) {
      const v = (row as any)[col.id]
      draft[col.id] = v != null ? String(v) : ''
    }
    setValues(draft)
  }, [row?._rowId, categoryGroup?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!categoryGroup) return null

  const sku = String((row as any)?.sku ?? '')

  // Group columns by guidance level (REQUIRED first)
  const required    = categoryGroup.columns.filter((c) => c.guidance === 'REQUIRED' || c.required)
  const recommended = categoryGroup.columns.filter((c) => c.guidance === 'RECOMMENDED' && !c.required)
  const optional    = categoryGroup.columns.filter((c) => !c.guidance || c.guidance === 'OPTIONAL')
    .filter((c) => !required.includes(c) && !recommended.includes(c))

  function setValue(id: string, v: string) {
    setValues((prev) => ({ ...prev, [id]: v }))
  }

  function handleSave() {
    if (!row) return
    onSave(row._rowId, values)
    onClose()
  }

  const cleanLabel = (raw: string) => raw.replace(/[\s*○↕⚠]+$/, '').trim()

  // EFX P4 — per-row applicability: the union group carries EVERY sheet
  // category's aspects; ones outside this row's category get a muted note
  // (same check the grid's not-applicable cell graying uses).
  const rowCategory = String((row as any)?.category_id ?? '').trim()
  const isNotApplicable = (c: { applicableCategories?: string[] }) =>
    Boolean(c.applicableCategories?.length && rowCategory && !c.applicableCategories.includes(rowCategory))

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={<span>Item Specifics{sku ? <span className="ml-2 text-xs font-mono font-normal text-slate-400">{sku}</span> : ''}</span>}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={handleSave}>Save aspects</Button>
        </>
      }
    >
      <div className="space-y-5">
        {required.length > 0 && (
          <Section label="Required" indicator={<span className="text-red-500">*</span>}>
            {required.map((col) => (
              <AspectField key={col.id} col={col} value={values[col.id] ?? ''} onChange={(v) => setValue(col.id, v)} cleanLabel={cleanLabel} notApplicable={isNotApplicable(col)} />
            ))}
          </Section>
        )}
        {recommended.length > 0 && (
          <Section label="Recommended" indicator={<span className="text-amber-500">○</span>}>
            {recommended.map((col) => (
              <AspectField key={col.id} col={col} value={values[col.id] ?? ''} onChange={(v) => setValue(col.id, v)} cleanLabel={cleanLabel} notApplicable={isNotApplicable(col)} />
            ))}
          </Section>
        )}
        {optional.length > 0 && (
          <Section label="Optional">
            {optional.map((col) => (
              <AspectField key={col.id} col={col} value={values[col.id] ?? ''} onChange={(v) => setValue(col.id, v)} cleanLabel={cleanLabel} notApplicable={isNotApplicable(col)} />
            ))}
          </Section>
        )}
        {required.length === 0 && recommended.length === 0 && optional.length === 0 && (
          <p className="text-sm text-slate-400 text-center py-8">No aspects loaded. Enter a category ID first.</p>
        )}
      </div>
    </Drawer>
  )
}

function Section({ label, indicator, children }: { label: string; indicator?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{label}</span>
        {indicator && <span className="text-xs">{indicator}</span>}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function AspectField({
  col,
  value,
  onChange,
  cleanLabel,
  notApplicable = false,
}: {
  col: { id: string; label: string; kind: string; options?: string[]; enumMode?: string; multiValue?: boolean; required?: boolean; guidance?: string; applicableCategories?: string[] }
  value: string
  onChange: (v: string) => void
  cleanLabel: (l: string) => string
  /** EFX P4 — aspect belongs to another sheet category, not this row's. */
  notApplicable?: boolean
}) {
  const label = cleanLabel(col.label)
  const isRequired = col.required || col.guidance === 'REQUIRED'

  return (
    <div className={cn('group', notApplicable && 'opacity-60')}>
      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
        {label}
        {isRequired && !notApplicable && <span className="ml-0.5 text-red-500">*</span>}
        {notApplicable && (
          <span className="ml-1.5 text-[10px] font-normal text-slate-400 dark:text-slate-500">
            not applicable to this row&rsquo;s category
          </span>
        )}
      </label>

      {col.options?.length ? (
        // Enum: show a <select> for strict enums, <datalist> input for open enums
        col.enumMode === 'strict' ? (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(
              'w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5',
              'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100',
              'focus:outline-none focus:ring-2 focus:ring-blue-500',
            )}
          >
            <option value="">— select —</option>
            {col.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : (
          <>
            <input
              type="text"
              list={`${col.id}-list`}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={`e.g. ${col.options[0] ?? '…'}`}
              className={cn(
                'w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5',
                'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100',
                'focus:outline-none focus:ring-2 focus:ring-blue-500',
              )}
            />
            <datalist id={`${col.id}-list`}>
              {col.options.map((opt) => <option key={opt} value={opt} />)}
            </datalist>
          </>
        )
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5',
            'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100',
            'focus:outline-none focus:ring-2 focus:ring-blue-500',
          )}
        />
      )}
    </div>
  )
}
