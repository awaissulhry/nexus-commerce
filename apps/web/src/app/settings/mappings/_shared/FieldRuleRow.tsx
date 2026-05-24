'use client'

/**
 * PIM D.2 — Single field-mapping row in the mappings editor.
 *
 * Renders one ChannelSchema field (label, fieldKey, max length /
 * required hints) next to its current FieldMappingRule (or "not
 * mapped" state). Inline editor for source path + fallback path +
 * required toggle; transforms editing is C.7b-style "JSON textarea"
 * for now (full transform DSL UI lands in D.3).
 */

import { useCallback, useEffect, useState } from 'react'
import { Save, Trash2, AlertTriangle } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import TransformsEditor, { type TransformOp } from './TransformsEditor'

export interface FieldRow {
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
  allowedValues: unknown
  notes: string | null
  rule: FieldMappingRule | null
}

export interface FieldMappingRule {
  source: string
  fallback?: string
  transforms?: Array<{ type: string; [k: string]: unknown }>
  required?: boolean
  notes?: string
}

interface Props {
  field: FieldRow
  onSave: (fieldKey: string, rule: FieldMappingRule) => Promise<void>
  onDelete: (fieldKey: string) => Promise<void>
}

export default function FieldRuleRow({ field, onSave, onDelete }: Props) {
  const [source, setSource] = useState(field.rule?.source ?? '')
  const [fallback, setFallback] = useState(field.rule?.fallback ?? '')
  const [requiredFlag, setRequiredFlag] = useState<boolean>(
    field.rule?.required ?? field.required,
  )
  const [transforms, setTransforms] = useState<TransformOp[]>(
    (field.rule?.transforms ?? []) as TransformOp[],
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  // Reset local state when the upstream field changes (e.g. after a
  // refetch elsewhere on the page).
  useEffect(() => {
    setSource(field.rule?.source ?? '')
    setFallback(field.rule?.fallback ?? '')
    setRequiredFlag(field.rule?.required ?? field.required)
    setTransforms((field.rule?.transforms ?? []) as TransformOp[])
    setParseError(null)
  }, [field.rule, field.required])

  const isMapped = field.rule != null
  const transformsKey = JSON.stringify(transforms)
  const ruleTransformsKey = JSON.stringify(field.rule?.transforms ?? [])
  const isDirty =
    source !== (field.rule?.source ?? '') ||
    fallback !== (field.rule?.fallback ?? '') ||
    requiredFlag !== (field.rule?.required ?? field.required) ||
    transformsKey !== ruleTransformsKey

  const handleSave = useCallback(async () => {
    if (source.trim() === '') {
      setParseError('source is required')
      return
    }
    const rule: FieldMappingRule = {
      source: source.trim(),
      fallback: fallback.trim() || undefined,
      required: requiredFlag || undefined,
      transforms: transforms.length > 0 ? transforms : undefined,
    }
    setSaving(true)
    setParseError(null)
    try {
      await onSave(field.fieldKey, rule)
    } finally {
      setSaving(false)
    }
  }, [source, fallback, requiredFlag, transforms, field.fieldKey, onSave])

  const handleDelete = useCallback(async () => {
    if (!isMapped) return
    setDeleting(true)
    try {
      await onDelete(field.fieldKey)
    } finally {
      setDeleting(false)
    }
  }, [isMapped, field.fieldKey, onDelete])

  return (
    <div
      className={cn(
        'border-b border-zinc-100 dark:border-zinc-800 px-4 py-3',
        isDirty && 'bg-amber-50/30 dark:bg-amber-900/10',
      )}
    >
      {/* Field meta header */}
      <div className="flex items-baseline justify-between mb-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-mono text-xs text-zinc-500">{field.fieldKey}</span>
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
            {field.label}
          </span>
          {field.required && (
            <span className="text-[10px] px-1 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              required
            </span>
          )}
          {field.maxLength && (
            <span className="text-[10px] text-zinc-500">max {field.maxLength}</span>
          )}
        </div>
        <span
          className={cn(
            'text-[10px] px-1.5 py-0.5 rounded font-medium',
            isMapped
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
          )}
        >
          {isMapped ? 'mapped' : 'not mapped'}
        </span>
      </div>

      {/* Editor grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
        <Labeled label="Source" hint="Dotted path. {locale} substituted at resolve time.">
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="localizedContent.{locale}.title"
            className="font-mono text-xs"
          />
        </Labeled>
        <Labeled label="Fallback" hint="Used when source resolves to null.">
          <Input
            value={fallback}
            onChange={(e) => setFallback(e.target.value)}
            placeholder="name"
            className="font-mono text-xs"
          />
        </Labeled>
      </div>

      <Labeled label="Transforms" hint="Applied in order; previewable via D.6">
        <TransformsEditor value={transforms} onChange={setTransforms} />
      </Labeled>

      <div className="flex items-center justify-between mt-2">
        <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={requiredFlag}
            onChange={(e) => setRequiredFlag(e.target.checked)}
            className="rounded border-zinc-300 dark:border-zinc-600 text-blue-600 focus:ring-blue-500"
          />
          Publish-required
        </label>
        <div className="flex items-center gap-2">
          {parseError && (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-600">
              <AlertTriangle className="w-3 h-3" />
              {parseError}
            </span>
          )}
          {isMapped && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={cn(
              'inline-flex items-center gap-1 px-3 py-1 text-xs rounded font-medium',
              'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving…' : isMapped ? 'Update' : 'Save mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <label className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">
          {label}
        </label>
        {hint && <span className="text-[10px] text-zinc-400 truncate">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
