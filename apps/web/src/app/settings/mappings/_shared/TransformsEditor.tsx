'use client'

/**
 * PIM D.3 — Transforms builder.
 *
 * Visual editor for the transform DSL shipped server-side in D.6.
 * Replaces the JSON textarea that D.2 originally used. Each transform
 * row picks its type from a dropdown and surfaces type-specific input
 * fields (truncate.max, prepend.value, replace.pattern+replacement,
 * default.value). Reorder via ↑/↓ buttons — drag-reorder is C.6b-
 * scope (same library would land here when we add it).
 *
 * Validation is best-effort: bad regex / missing required fields show
 * inline warnings; the parent's save handler does authoritative
 * validation through the A.3 service.
 */

import { useCallback } from 'react'
import { Plus, X, ChevronUp, ChevronDown, AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'

// Mirrors the server-side TransformOp union in schema-mapping.service.ts
// (FM.3). Kept as a local copy — the canvas doesn't import API types.
export type TransformOp =
  | { type: 'truncate'; max: number }
  | { type: 'titleCase' }
  | { type: 'lowerCase' }
  | { type: 'upperCase' }
  | { type: 'prepend'; value: string }
  | { type: 'append'; value: string }
  | { type: 'replace'; pattern: string; replacement: string }
  | { type: 'default'; value: string | number | boolean | null }
  // ── FM.3 data-backed + format ops ─────────────────────────────────
  | { type: 'valueMap'; attribute: string; onMiss?: 'keep' | 'null' | 'flag' }
  | { type: 'sizeScale'; scale: string; from: string; to: string; onMiss?: 'keep' | 'null' | 'flag' }
  | { type: 'unit'; from: string; to: string }
  | { type: 'numberFormat'; decimals?: number; decimalSep?: string; thousandsSep?: string }
  | { type: 'template'; expr: string }
  | { type: 'channelLimit'; max?: number; mode?: 'truncate' | 'flag' }
  | { type: 'translate' }

const TRANSFORM_TYPES: Array<{ type: TransformOp['type']; label: string; hint: string }> = [
  { type: 'truncate',  label: 'Truncate',   hint: 'Cap length to max characters' },
  { type: 'titleCase', label: 'Title Case', hint: 'Capitalize first letter of every word' },
  { type: 'lowerCase', label: 'lower case', hint: 'Lowercase the entire string' },
  { type: 'upperCase', label: 'UPPER CASE', hint: 'Uppercase the entire string' },
  { type: 'prepend',   label: 'Prepend',    hint: 'Add text at the start' },
  { type: 'append',    label: 'Append',     hint: 'Add text at the end' },
  { type: 'replace',   label: 'Replace',    hint: 'Regex find/replace (global)' },
  { type: 'default',   label: 'Default',    hint: 'Use this value if source resolves empty' },
  { type: 'valueMap',     label: 'Value map',     hint: 'Map canonical → market value (Rosso→Rot)' },
  { type: 'sizeScale',    label: 'Size scale',    hint: 'Convert size across systems (EU 52→L)' },
  { type: 'unit',         label: 'Unit convert',  hint: 'kg→lb, cm→in (numeric)' },
  { type: 'numberFormat', label: 'Number format', hint: 'Locale separators (5.5→5,5)' },
  { type: 'template',     label: 'Template',      hint: 'Interpolate {{attr}} placeholders' },
  { type: 'channelLimit', label: 'Channel limit', hint: 'Enforce the field max length' },
  { type: 'translate',    label: 'Translate',     hint: 'Flag for AI translation to the market language' },
]

interface Props {
  value: TransformOp[]
  onChange: (next: TransformOp[]) => void
}

export default function TransformsEditor({ value, onChange }: Props) {
  const update = useCallback(
    (index: number, patch: Partial<TransformOp>) => {
      const next = value.slice()
      next[index] = { ...next[index], ...patch } as TransformOp
      onChange(next)
    },
    [value, onChange],
  )

  const remove = useCallback(
    (index: number) => {
      onChange(value.filter((_, i) => i !== index))
    },
    [value, onChange],
  )

  const move = useCallback(
    (index: number, direction: -1 | 1) => {
      const target = index + direction
      if (target < 0 || target >= value.length) return
      const next = value.slice()
      ;[next[index], next[target]] = [next[target], next[index]]
      onChange(next)
    },
    [value, onChange],
  )

  const addTransform = useCallback(
    (type: TransformOp['type']) => {
      const seed = seedFor(type)
      onChange([...value, seed])
    },
    [value, onChange],
  )

  const changeType = useCallback(
    (index: number, type: TransformOp['type']) => {
      const next = value.slice()
      next[index] = seedFor(type)
      onChange(next)
    },
    [value, onChange],
  )

  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 ? (
        <div className="text-[11px] italic text-zinc-400">
          No transforms — the resolved value passes through as-is.
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {value.map((t, i) => (
            <li key={i}>
              <TransformRow
                index={i}
                isFirst={i === 0}
                isLast={i === value.length - 1}
                value={t}
                onChange={(patch) => update(i, patch)}
                onTypeChange={(type) => changeType(i, type)}
                onRemove={() => remove(i)}
                onMove={(dir) => move(i, dir)}
              />
            </li>
          ))}
        </ul>
      )}
      <AddTransformMenu onAdd={addTransform} />
    </div>
  )
}

function AddTransformMenu({ onAdd }: { onAdd: (type: TransformOp['type']) => void }) {
  return (
    <details className="text-[11px]">
      <summary className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer list-none">
        <Plus className="w-3 h-3" />
        Add transform
      </summary>
      <div className="mt-1 ml-1 flex flex-col gap-0.5 bg-zinc-50 dark:bg-zinc-900/50 rounded p-1">
        {TRANSFORM_TYPES.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => onAdd(t.type)}
            className="flex items-baseline justify-between text-left px-1.5 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <span className="font-mono text-zinc-700 dark:text-zinc-300">{t.label}</span>
            <span className="text-zinc-400 ml-2">{t.hint}</span>
          </button>
        ))}
      </div>
    </details>
  )
}

interface RowProps {
  index: number
  isFirst: boolean
  isLast: boolean
  value: TransformOp
  onChange: (patch: Partial<TransformOp>) => void
  onTypeChange: (type: TransformOp['type']) => void
  onRemove: () => void
  onMove: (direction: -1 | 1) => void
}

function TransformRow({
  index,
  isFirst,
  isLast,
  value,
  onChange,
  onTypeChange,
  onRemove,
  onMove,
}: RowProps) {
  const regexWarning = useRegexWarning(value)
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-1.5 py-1 rounded border',
        'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950',
      )}
    >
      <span className="text-[10px] text-zinc-400 w-4 text-right tabular-nums">{index + 1}</span>
      <select
        value={value.type}
        onChange={(e) => onTypeChange(e.target.value as TransformOp['type'])}
        className="px-1 py-0.5 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
      >
        {TRANSFORM_TYPES.map((t) => (
          <option key={t.type} value={t.type}>
            {t.label}
          </option>
        ))}
      </select>

      {/* Type-specific inputs */}
      <div className="flex-1 flex items-center gap-1">
        <TransformFields value={value} onChange={onChange} />
        {regexWarning && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300"
            title={regexWarning}
          >
            <AlertTriangle className="w-2.5 h-2.5" />
            invalid regex
          </span>
        )}
      </div>

      {/* Move + remove */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={isFirst}
          aria-label="Move up"
          className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed p-0.5"
        >
          <ChevronUp className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={isLast}
          aria-label="Move down"
          className="text-zinc-400 hover:text-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed p-0.5"
        >
          <ChevronDown className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove transform"
          className="text-zinc-400 hover:text-red-600 p-0.5"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  )
}

function TransformFields({
  value,
  onChange,
}: {
  value: TransformOp
  onChange: (patch: Partial<TransformOp>) => void
}) {
  switch (value.type) {
    case 'truncate':
      return (
        <Input
          type="number"
          min={1}
          value={value.max}
          onChange={(e) => onChange({ max: Number(e.target.value) } as Partial<TransformOp>)}
          className="w-20 text-[11px]"
          aria-label="Truncate to N characters"
        />
      )
    case 'prepend':
    case 'append':
      return (
        <Input
          value={value.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value } as Partial<TransformOp>)}
          placeholder={value.type === 'prepend' ? 'prefix text' : 'suffix text'}
          className="flex-1 text-[11px]"
        />
      )
    case 'replace':
      return (
        <div className="flex items-center gap-1 flex-1">
          <Input
            value={value.pattern ?? ''}
            onChange={(e) => onChange({ pattern: e.target.value } as Partial<TransformOp>)}
            placeholder="regex pattern"
            className="flex-1 text-[11px] font-mono"
          />
          <span className="text-zinc-400 text-[10px]">→</span>
          <Input
            value={value.replacement ?? ''}
            onChange={(e) =>
              onChange({ replacement: e.target.value } as Partial<TransformOp>)
            }
            placeholder="replacement"
            className="flex-1 text-[11px] font-mono"
          />
        </div>
      )
    case 'default':
      return (
        <Input
          value={value.value == null ? '' : String(value.value)}
          onChange={(e) => onChange({ value: e.target.value } as Partial<TransformOp>)}
          placeholder="value when source is empty"
          className="flex-1 text-[11px]"
        />
      )
    case 'valueMap':
      return (
        <div className="flex items-center gap-1 flex-1">
          <Input
            value={value.attribute ?? ''}
            onChange={(e) => onChange({ attribute: e.target.value } as Partial<TransformOp>)}
            placeholder="canonical attribute (e.g. color)"
            className="flex-1 text-[11px] font-mono"
            aria-label="value-map attribute"
          />
          <OnMissSelect value={value.onMiss} onChange={(onMiss) => onChange({ onMiss } as Partial<TransformOp>)} />
        </div>
      )
    case 'sizeScale':
      return (
        <div className="flex items-center gap-1 flex-1">
          <Input
            value={value.scale ?? ''}
            onChange={(e) => onChange({ scale: e.target.value } as Partial<TransformOp>)}
            placeholder="scale (e.g. MENS_JACKET)"
            className="flex-1 text-[11px] font-mono"
            aria-label="size scale"
          />
          <Input
            value={value.from ?? ''}
            onChange={(e) => onChange({ from: e.target.value } as Partial<TransformOp>)}
            placeholder="EU"
            className="w-14 text-[11px]"
            aria-label="from system"
          />
          <span className="text-zinc-400 text-[10px]">→</span>
          <Input
            value={value.to ?? ''}
            onChange={(e) => onChange({ to: e.target.value } as Partial<TransformOp>)}
            placeholder="ALPHA"
            className="w-16 text-[11px]"
            aria-label="to system"
          />
          <OnMissSelect value={value.onMiss} onChange={(onMiss) => onChange({ onMiss } as Partial<TransformOp>)} />
        </div>
      )
    case 'unit':
      return (
        <div className="flex items-center gap-1">
          <Input
            value={value.from ?? ''}
            onChange={(e) => onChange({ from: e.target.value } as Partial<TransformOp>)}
            placeholder="kg"
            className="w-16 text-[11px]"
            aria-label="from unit"
          />
          <span className="text-zinc-400 text-[10px]">→</span>
          <Input
            value={value.to ?? ''}
            onChange={(e) => onChange({ to: e.target.value } as Partial<TransformOp>)}
            placeholder="lb"
            className="w-16 text-[11px]"
            aria-label="to unit"
          />
        </div>
      )
    case 'numberFormat':
      return (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={0}
            value={value.decimals ?? 2}
            onChange={(e) => onChange({ decimals: Number(e.target.value) } as Partial<TransformOp>)}
            className="w-14 text-[11px]"
            aria-label="decimals"
          />
          <Input
            value={value.decimalSep ?? ''}
            onChange={(e) => onChange({ decimalSep: e.target.value } as Partial<TransformOp>)}
            placeholder="dec sep"
            className="w-16 text-[11px]"
            aria-label="decimal separator"
          />
          <Input
            value={value.thousandsSep ?? ''}
            onChange={(e) => onChange({ thousandsSep: e.target.value } as Partial<TransformOp>)}
            placeholder="thousands"
            className="w-20 text-[11px]"
            aria-label="thousands separator"
          />
        </div>
      )
    case 'template':
      return (
        <Input
          value={value.expr ?? ''}
          onChange={(e) => onChange({ expr: e.target.value } as Partial<TransformOp>)}
          placeholder="{{brand}} {{name}}"
          className="flex-1 text-[11px] font-mono"
          aria-label="template expression"
        />
      )
    case 'channelLimit':
      return (
        <div className="flex items-center gap-1">
          <Input
            type="number"
            min={1}
            value={value.max ?? ''}
            onChange={(e) =>
              onChange({ max: e.target.value ? Number(e.target.value) : undefined } as Partial<TransformOp>)
            }
            placeholder="max (or schema)"
            className="w-28 text-[11px]"
            aria-label="channel max length"
          />
          <select
            value={value.mode ?? 'truncate'}
            onChange={(e) => onChange({ mode: e.target.value as 'truncate' | 'flag' } as Partial<TransformOp>)}
            className="px-1 py-0.5 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
            aria-label="over-limit mode"
          >
            <option value="truncate">truncate</option>
            <option value="flag">flag</option>
          </select>
        </div>
      )
    case 'translate':
      return (
        <span className="text-[10px] text-zinc-400 italic">
          (AI-translated to the market language at apply time)
        </span>
      )
    case 'titleCase':
    case 'lowerCase':
    case 'upperCase':
    default:
      return <span className="text-[10px] text-zinc-400 italic">(no parameters)</span>
  }
}

function OnMissSelect({
  value,
  onChange,
}: {
  value?: 'keep' | 'null' | 'flag'
  onChange: (v: 'keep' | 'null' | 'flag') => void
}) {
  return (
    <select
      value={value ?? 'keep'}
      onChange={(e) => onChange(e.target.value as 'keep' | 'null' | 'flag')}
      className="px-1 py-0.5 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
      aria-label="on miss"
      title="What to do when no mapping/conversion is found"
    >
      <option value="keep">miss→keep</option>
      <option value="null">miss→null</option>
      <option value="flag">miss→flag</option>
    </select>
  )
}

function seedFor(type: TransformOp['type']): TransformOp {
  switch (type) {
    case 'truncate':
      return { type, max: 200 }
    case 'prepend':
    case 'append':
      return { type, value: '' }
    case 'replace':
      return { type, pattern: '', replacement: '' }
    case 'default':
      return { type, value: '' }
    case 'titleCase':
    case 'lowerCase':
    case 'upperCase':
      return { type }
    case 'valueMap':
      return { type, attribute: '', onMiss: 'keep' }
    case 'sizeScale':
      return { type, scale: '', from: 'EU', to: 'ALPHA', onMiss: 'keep' }
    case 'unit':
      return { type, from: 'kg', to: 'lb' }
    case 'numberFormat':
      return { type, decimals: 2, decimalSep: ',', thousandsSep: '' }
    case 'template':
      return { type, expr: '' }
    case 'channelLimit':
      return { type, mode: 'truncate' }
    case 'translate':
      return { type }
  }
}

/** Returns a warning message if a replace transform has an invalid
 *  regex pattern. Compiles on every render — cheap, no caching. */
function useRegexWarning(t: TransformOp): string | null {
  if (t.type !== 'replace') return null
  if (!t.pattern) return null
  try {
    new RegExp(t.pattern, 'g')
    return null
  } catch (e: any) {
    return `invalid regex: ${e?.message ?? 'unknown'}`
  }
}
