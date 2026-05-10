'use client'

// MC.10.3 — Watermark templates editor.
//
// Slots into BrandKitEditClient as a 6th section. Lists existing
// templates per brand with enabled toggle, edit-in-modal, delete,
// and a live Cloudinary preview against an operator-pasted test
// asset URL.

import { useEffect, useState } from 'react'
import {
  Plus,
  Stamp,
  Trash2,
  Loader2,
  Save,
  Eye,
} from 'lucide-react'
import Image from 'next/image'
import { Button } from '@/components/ui/Button'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  WATERMARK_SPECS,
  applyWatermarkToUrl,
  type WatermarkType,
} from '../_lib/watermarks'

interface Watermark {
  id: string
  brand: string
  name: string
  type: string
  config: Record<string, unknown>
  enabled: boolean
}

interface Props {
  brand: string
  apiBase: string
}

export default function WatermarksSection({ brand, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [watermarks, setWatermarks] = useState<Watermark[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Watermark | null>(null)
  const [creating, setCreating] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${apiBase}/api/brand-kits/${encodeURIComponent(brand)}/watermarks`,
        { cache: 'no-store' },
      )
      if (res.status === 404) {
        // Brand kit doesn't exist yet — Save the identity section
        // first to create one. Show empty list, no error toast.
        setWatermarks([])
        return
      }
      if (!res.ok) throw new Error(`Watermarks API returned ${res.status}`)
      const data = (await res.json()) as { watermarks: Watermark[] }
      setWatermarks(data.watermarks)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('brandKit.watermarks.loadError'),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand])

  const toggleEnabled = async (wm: Watermark) => {
    try {
      const res = await fetch(
        `${apiBase}/api/brand-watermarks/${encodeURIComponent(wm.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !wm.enabled }),
        },
      )
      if (!res.ok) throw new Error(`Toggle failed (${res.status})`)
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('brandKit.watermarks.toggleError'),
      )
    }
  }

  const remove = async (wm: Watermark) => {
    if (!window.confirm(t('brandKit.watermarks.deleteConfirm', { name: wm.name }))) return
    try {
      const res = await fetch(
        `${apiBase}/api/brand-watermarks/${encodeURIComponent(wm.id)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) throw new Error(`Delete failed (${res.status})`)
      toast.success(t('brandKit.watermarks.deleted'))
      await load()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('brandKit.watermarks.deleteError'),
      )
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <Stamp className="w-4 h-4 text-slate-400" />
          {t('brandKit.watermarks.title', {
            n: watermarks.length.toString(),
          })}
        </h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreating(true)}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          {t('brandKit.watermarks.addCta')}
        </Button>
      </header>

      <div className="space-y-2">
        {/* Test preview URL */}
        <label className="block">
          <span className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
            <Eye className="w-3.5 h-3.5 text-slate-400" />
            {t('brandKit.watermarks.previewLabel')}
          </span>
          <input
            type="url"
            value={previewUrl}
            onChange={(e) => setPreviewUrl(e.target.value)}
            placeholder={t('brandKit.watermarks.previewPlaceholder')}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <span className="mt-1 block text-[11px] text-slate-500 dark:text-slate-400">
            {t('brandKit.watermarks.previewHint')}
          </span>
        </label>

        {loading ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/50">
            {t('brandKit.watermarks.loading')}
          </p>
        ) : watermarks.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-3 text-xs italic text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
            {t('brandKit.watermarks.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {watermarks.map((wm) => {
              const previewedUrl =
                previewUrl &&
                applyWatermarkToUrl(
                  previewUrl,
                  wm.type as WatermarkType,
                  wm.config,
                )
              return (
                <li
                  key={wm.id}
                  className={`rounded-md border p-2 ${
                    wm.enabled
                      ? 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'
                      : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        wm.enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {wm.name}
                      </p>
                      <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                        {wm.type}
                      </p>
                    </div>
                    <label className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-400">
                      <input
                        type="checkbox"
                        checked={wm.enabled}
                        onChange={() => toggleEnabled(wm)}
                        className="h-3.5 w-3.5"
                      />
                      {wm.enabled
                        ? t('brandKit.watermarks.enabled')
                        : t('brandKit.watermarks.disabled')}
                    </label>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditing(wm)}
                    >
                      {t('common.edit')}
                    </Button>
                    <button
                      type="button"
                      onClick={() => remove(wm)}
                      aria-label={t('common.delete')}
                      className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {previewedUrl && (
                    <div className="mt-2 relative aspect-video w-full overflow-hidden rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
                      <Image
                        src={previewedUrl}
                        alt={`Preview of ${wm.name}`}
                        fill
                        sizes="(min-width: 1024px) 600px, 100vw"
                        className="object-contain"
                        unoptimized
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {(editing || creating) && (
        <WatermarkEditor
          brand={brand}
          apiBase={apiBase}
          watermark={editing}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
          onSaved={async () => {
            setEditing(null)
            setCreating(false)
            await load()
          }}
        />
      )}
    </section>
  )
}

interface EditorProps {
  brand: string
  apiBase: string
  watermark: Watermark | null
  onClose: () => void
  onSaved: () => void
}

function WatermarkEditor({
  brand,
  apiBase,
  watermark,
  onClose,
  onSaved,
}: EditorProps) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [name, setName] = useState(watermark?.name ?? '')
  const [type, setType] = useState<WatermarkType>(
    (watermark?.type as WatermarkType) ?? 'corner_logo',
  )
  const [config, setConfig] = useState<Record<string, unknown>>(
    watermark?.config ?? {},
  )
  const [busy, setBusy] = useState(false)

  const setConfigField = (key: string, value: unknown) =>
    setConfig({ ...config, [key]: value })

  const submit = async () => {
    if (!name.trim()) {
      toast.error(t('brandKit.watermarks.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const url = watermark
        ? `${apiBase}/api/brand-watermarks/${encodeURIComponent(watermark.id)}`
        : `${apiBase}/api/brand-kits/${encodeURIComponent(brand)}/watermarks`
      const res = await fetch(url, {
        method: watermark ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type,
          config,
        }),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Save failed (${res.status})`)
      }
      toast.success(t('brandKit.watermarks.saved'))
      onSaved()
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('brandKit.watermarks.saveError'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={() => {
        if (busy) return
        onClose()
      }}
      title={
        watermark
          ? t('brandKit.watermarks.editTitle')
          : t('brandKit.watermarks.createTitle')
      }
      size="lg"
    >
      <ModalBody>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandKit.watermarks.field.name')}
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('brandKit.watermarks.field.type')}
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as WatermarkType)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            >
              {WATERMARK_SPECS.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.label} — {spec.description}
                </option>
              ))}
            </select>
          </label>

          {(type === 'corner_logo' || type === 'badge') && (
            <>
              <Field label={t('brandKit.watermarks.field.logoUrl')}>
                <input
                  type="url"
                  value={(config.logoUrl as string) ?? ''}
                  onChange={(e) => setConfigField('logoUrl', e.target.value)}
                  placeholder="https://res.cloudinary.com/…/brand-mark.png"
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </Field>
              {type === 'corner_logo' && (
                <Field label={t('brandKit.watermarks.field.position')}>
                  <select
                    value={(config.position as string) ?? 'SE'}
                    onChange={(e) =>
                      setConfigField('position', e.target.value)
                    }
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value="NW">North-west</option>
                    <option value="NE">North-east</option>
                    <option value="SW">South-west</option>
                    <option value="SE">South-east (default)</option>
                  </select>
                </Field>
              )}
              <NumberField
                label={t('brandKit.watermarks.field.widthPct')}
                value={(config.widthPct as number) ?? 12}
                onChange={(v) => setConfigField('widthPct', v)}
                min={1}
                max={50}
                suffix="%"
              />
              <NumberField
                label={t('brandKit.watermarks.field.opacity')}
                value={(config.opacity as number) ?? 80}
                onChange={(v) => setConfigField('opacity', v)}
                min={0}
                max={100}
                suffix="%"
              />
              {type === 'corner_logo' && (
                <NumberField
                  label={t('brandKit.watermarks.field.padding')}
                  value={(config.paddingPx as number) ?? 24}
                  onChange={(v) => setConfigField('paddingPx', v)}
                  min={0}
                  max={200}
                  suffix="px"
                />
              )}
            </>
          )}

          {(type === 'overlay_band' || type === 'diagonal_text') && (
            <>
              <Field label={t('brandKit.watermarks.field.text')}>
                <input
                  type="text"
                  value={(config.text as string) ?? ''}
                  onChange={(e) => setConfigField('text', e.target.value)}
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </Field>
              <Field label={t('brandKit.watermarks.field.color')}>
                <input
                  type="color"
                  value={(config.color as string) ?? '#FFFFFF'}
                  onChange={(e) => setConfigField('color', e.target.value)}
                  className="h-8 w-16 cursor-pointer rounded"
                />
              </Field>
              <NumberField
                label={t('brandKit.watermarks.field.fontSize')}
                value={
                  (config.fontSize as number) ??
                  (type === 'overlay_band' ? 36 : 60)
                }
                onChange={(v) => setConfigField('fontSize', v)}
                min={8}
                max={200}
                suffix="px"
              />
              <NumberField
                label={t('brandKit.watermarks.field.opacity')}
                value={
                  (config.opacity as number) ??
                  (type === 'diagonal_text' ? 30 : 100)
                }
                onChange={(v) => setConfigField('opacity', v)}
                min={0}
                max={100}
                suffix="%"
              />
              {type === 'overlay_band' && (
                <Field label={t('brandKit.watermarks.field.position')}>
                  <select
                    value={(config.position as string) ?? 'bottom'}
                    onChange={(e) =>
                      setConfigField('position', e.target.value)
                    }
                    className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                  >
                    <option value="top">Top</option>
                    <option value="bottom">Bottom (default)</option>
                  </select>
                </Field>
              )}
              {type === 'diagonal_text' && (
                <NumberField
                  label={t('brandKit.watermarks.field.angle')}
                  value={(config.angle as number) ?? 315}
                  onChange={(v) => setConfigField('angle', v)}
                  min={0}
                  max={360}
                  suffix="°"
                />
              )}
            </>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? (
            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-1" />
          )}
          {t('common.save')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  suffix?: string
}) {
  return (
    <Field label={`${label}${suffix ? ` (${suffix})` : ''}`}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1"
        />
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </div>
    </Field>
  )
}
