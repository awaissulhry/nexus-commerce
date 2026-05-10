'use client'

// MC.6.3 — Locale-specific overlay manager.
//
// Lives inside the AssetDetailDrawer and lets the operator set
// localized text strips ("FREE SHIPPING" / "SPEDIZIONE GRATUITA") on
// top of a master Cloudinary asset. Each row maps to one
// AssetLocaleOverlay; the channel-variants builder splices them in
// at delivery time per the request locale.

import { useEffect, useState } from 'react'
import { Globe, Plus, Trash2, Save } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'

interface OverlayRow {
  id: string
  locale: string
  text: string
  position: string
  color: string
  bgColor: string | null
  font: string
  offsetY: number
  offsetX: number
  enabled: boolean
}

interface Props {
  assetId: string
  apiBase: string
}

const POSITIONS = [
  'south',
  'south_east',
  'south_west',
  'north',
  'north_east',
  'north_west',
  'east',
  'west',
  'center',
]

const STARTER_LOCALES = ['it-IT', 'en-US', 'en-GB', 'es-ES', 'fr-FR', 'de-DE']

export default function LocaleOverlayManager({ assetId, apiBase }: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [overlays, setOverlays] = useState<OverlayRow[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [draftLocale, setDraftLocale] = useState('it-IT')
  const [draftText, setDraftText] = useState('')

  // Strip the source-prefix (da_/pi_) — overlay routes only support
  // DigitalAsset rows. ProductImage rows aren't taggable yet either.
  const supports = assetId.startsWith('da_')
  const cleanId = assetId.startsWith('da_') ? assetId.slice(3) : assetId

  useEffect(() => {
    if (!supports) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`${apiBase}/api/assets/${cleanId}/locale-overlays`)
      .then((r) => (r.ok ? r.json() : { overlays: [] }))
      .then((d: { overlays: OverlayRow[] }) => {
        if (!cancelled) setOverlays(d.overlays)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [supports, cleanId, apiBase])

  const upsert = async (row: OverlayRow) => {
    const res = await fetch(
      `${apiBase}/api/assets/${cleanId}/locale-overlays/${encodeURIComponent(row.locale)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: row.text,
          position: row.position,
          color: row.color,
          bgColor: row.bgColor,
          font: row.font,
          offsetY: row.offsetY,
          offsetX: row.offsetX,
          enabled: row.enabled,
        }),
      },
    )
    if (res.ok) {
      const data = (await res.json()) as { overlay: OverlayRow }
      setOverlays((prev) => {
        const exists = prev.find((o) => o.locale === row.locale)
        if (exists)
          return prev.map((o) =>
            o.locale === row.locale ? data.overlay : o,
          )
        return [...prev, data.overlay].sort((a, b) =>
          a.locale.localeCompare(b.locale),
        )
      })
      toast.success(t('marketingContent.overlays.saved'))
    } else {
      toast.error(t('marketingContent.overlays.saveFailed'))
    }
  }

  const remove = async (locale: string) => {
    const res = await fetch(
      `${apiBase}/api/assets/${cleanId}/locale-overlays/${encodeURIComponent(locale)}`,
      { method: 'DELETE' },
    )
    if (res.ok) {
      setOverlays((prev) => prev.filter((o) => o.locale !== locale))
      toast.success(t('marketingContent.overlays.deleted'))
    } else {
      toast.error(t('marketingContent.overlays.deleteFailed'))
    }
  }

  const addDraft = () => {
    if (!draftText.trim() || !draftLocale.trim()) return
    void upsert({
      id: '',
      locale: draftLocale.trim(),
      text: draftText.trim(),
      position: 'south',
      color: 'white',
      bgColor: 'black',
      font: 'Arial_60_bold',
      offsetY: 24,
      offsetX: 0,
      enabled: true,
    })
    setDraftText('')
    setAdding(false)
  }

  if (!supports) return null

  return (
    <section
      aria-label={t('marketingContent.overlays.label')}
      className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800"
    >
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <Globe className="w-3.5 h-3.5" />
          {t('marketingContent.overlays.title', {
            n: overlays.length.toString(),
          })}
        </h3>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('marketingContent.overlays.add')}
        </button>
      </header>

      {loading ? (
        <p className="text-xs text-slate-400">
          {t('marketingContent.overlays.loading')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {overlays.map((row) => (
            <li
              key={row.id || row.locale}
              className="rounded border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="flex items-start gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-mono text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                  {row.locale}
                </span>
                <input
                  className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-800"
                  defaultValue={row.text}
                  onBlur={(e) => {
                    if (e.target.value !== row.text)
                      void upsert({ ...row, text: e.target.value })
                  }}
                />
                <button
                  type="button"
                  onClick={() => remove(row.locale)}
                  aria-label={t('marketingContent.overlays.delete')}
                  className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-900/30"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <select
                  className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-800"
                  defaultValue={row.position}
                  onChange={(e) =>
                    void upsert({ ...row, position: e.target.value })
                  }
                >
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(e) =>
                      void upsert({ ...row, enabled: e.target.checked })
                    }
                  />
                  {t('marketingContent.overlays.enabled')}
                </label>
              </div>
            </li>
          ))}
          {overlays.length === 0 && !adding && (
            <li className="text-xs italic text-slate-400">
              {t('marketingContent.overlays.empty')}
            </li>
          )}
        </ul>
      )}

      {adding && (
        <div className="flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800">
          <select
            className="rounded border border-slate-200 bg-white px-1.5 py-1 text-[11px] dark:border-slate-700 dark:bg-slate-900"
            value={draftLocale}
            onChange={(e) => setDraftLocale(e.target.value)}
          >
            {STARTER_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <input
            placeholder={t('marketingContent.overlays.placeholder')}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addDraft()
            }}
            className="flex-1 rounded border border-slate-200 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={addDraft}
            disabled={!draftText.trim()}
            className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            <Save className="w-3 h-3" />
            {t('marketingContent.overlays.save')}
          </button>
        </div>
      )}
    </section>
  )
}
