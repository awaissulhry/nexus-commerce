'use client'

// MC.8.3 — module property editor (right rail).
//
// Reads the selected module's spec, renders one input per FieldSpec,
// and emits onChange for the entire payload object on every keystroke
// (parent debounces network persist optimistically).
//
// Field kinds:
//   text          single-line input
//   textarea      multi-line
//   asset_id      DAM asset picker (placeholder until MC.8.4)
//   asin          single-ASIN input
//   list_text     dynamic list of strings
//   list_image    list of { assetId, headline, body }
//   list_qa       list of { question, answer }
//
// MC.8.4 / MC.8.5 add per-module bespoke widgets (DAM picker, ASIN
// search) without changing this component's shape.

import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  getModuleSpec,
  type FieldSpec,
} from '../_lib/modules'
import type { AplusModuleRow } from '../_lib/types'

interface Props {
  module: AplusModuleRow | null
  onChange: (
    moduleId: string,
    payload: Record<string, unknown>,
  ) => void
  validationByModule: Map<string, string[]>
}

export default function ModuleEditor({
  module,
  onChange,
  validationByModule,
}: Props) {
  const { t } = useTranslations()

  if (!module) {
    return (
      <aside
        aria-label={t('aplus.builder.editorLabel')}
        className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
      >
        {t('aplus.builder.editorEmpty')}
      </aside>
    )
  }

  const spec = getModuleSpec(module.type)
  const issues = validationByModule.get(module.id) ?? []

  const setValue = (key: string, value: unknown) => {
    onChange(module.id, { ...module.payload, [key]: value })
  }

  return (
    <aside
      aria-label={t('aplus.builder.editorLabel')}
      className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {spec?.label ?? module.type}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {spec?.description ?? t('aplus.builder.unknownType', { type: module.type })}
        </p>
      </header>

      {issues.length > 0 && (
        <ul className="border-b border-slate-200 bg-amber-50 px-3 py-2 text-xs dark:border-slate-800 dark:bg-amber-950/30">
          {issues.map((issue, idx) => (
            <li
              key={idx}
              className="flex items-start gap-1 text-amber-900 dark:text-amber-200"
            >
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
              <span>{issue}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {spec ? (
          spec.fields.map((field) => (
            <FieldEditor
              key={field.key}
              field={field}
              value={module.payload[field.key]}
              onChange={(v) => setValue(field.key, v)}
            />
          ))
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('aplus.builder.specMissing')}
          </p>
        )}
      </div>
    </aside>
  )
}

interface FieldEditorProps {
  field: FieldSpec
  value: unknown
  onChange: (next: unknown) => void
}

function FieldEditor({ field, value, onChange }: FieldEditorProps) {
  const { t } = useTranslations()
  const id = `field-${field.key}`

  const Label = () => (
    <label
      htmlFor={id}
      className="flex items-baseline justify-between text-xs font-medium text-slate-700 dark:text-slate-300"
    >
      <span>
        {field.label}
        {field.required && (
          <span className="ml-0.5 text-red-500">*</span>
        )}
      </span>
      {field.max && typeof value === 'string' && (
        <span className="text-[10px] text-slate-400">
          {value.length}/{field.max}
        </span>
      )}
      {field.max && Array.isArray(value) && (
        <span className="text-[10px] text-slate-400">
          {value.length}/{field.max}
        </span>
      )}
    </label>
  )

  if (field.kind === 'text') {
    return (
      <div className="space-y-1">
        <Label />
        <input
          id={id}
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.max}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {field.hint && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    )
  }

  if (field.kind === 'textarea') {
    return (
      <div className="space-y-1">
        <Label />
        <textarea
          id={id}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.max}
          rows={4}
          className="w-full resize-y rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        {field.hint && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {field.hint}
          </p>
        )}
      </div>
    )
  }

  if (field.kind === 'asset_id') {
    return (
      <div className="space-y-1">
        <Label />
        <input
          id={id}
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('aplus.builder.assetIdPlaceholder')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          {field.hint ?? t('aplus.builder.assetIdHint')}
        </p>
      </div>
    )
  }

  if (field.kind === 'asin') {
    return (
      <div className="space-y-1">
        <Label />
        <input
          id={id}
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          maxLength={10}
          placeholder="B0XXXXXXX"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs uppercase focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
    )
  }

  if (field.kind === 'list_text') {
    const list = Array.isArray(value) ? (value as string[]) : []
    const setItem = (idx: number, next: string) => {
      const copy = [...list]
      copy[idx] = next
      onChange(copy)
    }
    const removeItem = (idx: number) => {
      const copy = [...list]
      copy.splice(idx, 1)
      onChange(copy)
    }
    const addItem = () => onChange([...list, ''])
    return (
      <div className="space-y-1">
        <Label />
        <ul className="space-y-1">
          {list.map((item, idx) => (
            <li key={idx} className="flex items-center gap-1">
              <input
                type="text"
                value={item}
                onChange={(e) => setItem(idx, e.target.value)}
                className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => removeItem(idx)}
                aria-label={t('aplus.builder.listRemove')}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addItem}
          disabled={!!field.max && list.length >= field.max}
          className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('aplus.builder.listAdd')}
        </button>
      </div>
    )
  }

  if (field.kind === 'list_image') {
    interface ImageItem {
      assetId?: string
      url?: string
      headline?: string
      body?: string
      alt?: string
    }
    const list = Array.isArray(value) ? (value as ImageItem[]) : []
    const setItem = (idx: number, patch: Partial<ImageItem>) => {
      const copy = [...list]
      copy[idx] = { ...(copy[idx] ?? {}), ...patch }
      onChange(copy)
    }
    const removeItem = (idx: number) => {
      const copy = [...list]
      copy.splice(idx, 1)
      onChange(copy)
    }
    const addItem = () => onChange([...list, {}])
    return (
      <div className="space-y-1">
        <Label />
        <ul className="space-y-2">
          {list.map((item, idx) => (
            <li
              key={idx}
              className="space-y-1 rounded-md border border-slate-200 p-2 dark:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-slate-500">
                  #{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  aria-label={t('aplus.builder.listRemove')}
                  className="rounded p-0.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <input
                type="text"
                value={item.assetId ?? ''}
                onChange={(e) => setItem(idx, { assetId: e.target.value })}
                placeholder={t('aplus.builder.assetIdPlaceholder')}
                className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="text"
                value={item.headline ?? ''}
                onChange={(e) => setItem(idx, { headline: e.target.value })}
                placeholder={t('aplus.builder.headlinePlaceholder')}
                className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <textarea
                value={item.body ?? ''}
                onChange={(e) => setItem(idx, { body: e.target.value })}
                rows={2}
                placeholder={t('aplus.builder.bodyPlaceholder')}
                className="w-full resize-y rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addItem}
          disabled={!!field.max && list.length >= field.max}
          className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('aplus.builder.listAddImage')}
        </button>
      </div>
    )
  }

  if (field.kind === 'list_qa') {
    interface QaItem {
      question?: string
      answer?: string
    }
    const list = Array.isArray(value) ? (value as QaItem[]) : []
    const setItem = (idx: number, patch: Partial<QaItem>) => {
      const copy = [...list]
      copy[idx] = { ...(copy[idx] ?? {}), ...patch }
      onChange(copy)
    }
    const removeItem = (idx: number) => {
      const copy = [...list]
      copy.splice(idx, 1)
      onChange(copy)
    }
    const addItem = () => onChange([...list, {}])
    return (
      <div className="space-y-1">
        <Label />
        <ul className="space-y-2">
          {list.map((item, idx) => (
            <li
              key={idx}
              className="space-y-1 rounded-md border border-slate-200 p-2 dark:border-slate-700"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-slate-500">
                  Q{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeItem(idx)}
                  aria-label={t('aplus.builder.listRemove')}
                  className="rounded p-0.5 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
              <input
                type="text"
                value={item.question ?? ''}
                onChange={(e) => setItem(idx, { question: e.target.value })}
                placeholder={t('aplus.builder.questionPlaceholder')}
                className="w-full rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <textarea
                value={item.answer ?? ''}
                onChange={(e) => setItem(idx, { answer: e.target.value })}
                rows={2}
                placeholder={t('aplus.builder.answerPlaceholder')}
                className="w-full resize-y rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={addItem}
          disabled={!!field.max && list.length >= field.max}
          className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('aplus.builder.listAddQa')}
        </button>
      </div>
    )
  }

  return null
}
