'use client'

// MC.10.1 — Brand Kit edit client.
//
// Single-page editor with five sections: identity (display name +
// tagline + voice notes), colors, fonts, logos, notes. Each section
// has its own Save button so the operator can save partial work
// without filling everything in. PUT is upsert by brand path.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  Palette,
  Save,
  Plus,
  Trash2,
  Loader2,
  Type,
  Image as ImageIcon,
  Quote,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  COLOR_ROLES,
  FONT_ROLES,
  LOGO_ROLES,
  type BrandKitRow,
  type ColorEntry,
  type ColorRole,
  type FontEntry,
  type FontRole,
  type LogoEntry,
  type LogoRole,
} from '../_lib/types'
import WatermarksSection from './WatermarksSection'
import ConsistencySection from './ConsistencySection'

interface Props {
  brand: string
  initial: BrandKitRow | null
  apiBase: string
}

export default function BrandKitEditClient({
  brand,
  initial,
  apiBase,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const router = useRouter()

  const [displayName, setDisplayName] = useState(
    initial?.displayName ?? brand,
  )
  const [tagline, setTagline] = useState(initial?.tagline ?? '')
  const [voiceNotes, setVoiceNotes] = useState(initial?.voiceNotes ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')
  const [colors, setColors] = useState<ColorEntry[]>(initial?.colors ?? [])
  const [fonts, setFonts] = useState<FontEntry[]>(initial?.fonts ?? [])
  const [logos, setLogos] = useState<LogoEntry[]>(initial?.logos ?? [])
  const [busy, setBusy] = useState<null | string>(null)

  const save = async (
    section: 'identity' | 'colors' | 'fonts' | 'logos' | 'notes',
    body: Record<string, unknown>,
  ) => {
    setBusy(section)
    try {
      const res = await fetch(
        `${apiBase}/api/brand-kits/${encodeURIComponent(brand)}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(errBody.error ?? `Save failed (${res.status})`)
      }
      toast.success(t('brandKit.savedSection', { section }))
      router.refresh()
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('brandKit.saveError'),
      )
    } finally {
      setBusy(null)
    }
  }

  const isNew = !initial

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/marketing/brand-kit"
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('brandKit.backToList')}
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          <Palette className="w-5 h-5 text-blue-500" />
          {brand}
          {isNew && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
              {t('brandKit.newBadge')}
            </span>
          )}
        </h1>
        {isNew && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t('brandKit.newHint')}
          </p>
        )}
      </div>

      {/* MC.10.4 — Consistency monitoring (only for existing kits) */}
      {!isNew && <ConsistencySection brand={brand} apiBase={apiBase} />}

      {/* Identity section */}
      <Section
        icon={<Quote className="w-4 h-4 text-slate-400" />}
        title={t('brandKit.section.identity')}
        onSave={() =>
          save('identity', { displayName, tagline, voiceNotes })
        }
        busy={busy === 'identity'}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('brandKit.field.displayName')}>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </Field>
          <Field label={t('brandKit.field.tagline')}>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              placeholder={t('brandKit.field.taglinePlaceholder')}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </Field>
        </div>
        <Field label={t('brandKit.field.voiceNotes')}>
          <textarea
            value={voiceNotes}
            onChange={(e) => setVoiceNotes(e.target.value)}
            placeholder={t('brandKit.field.voicePlaceholder')}
            rows={4}
            className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            {t('brandKit.field.voiceHint')}
          </p>
        </Field>
      </Section>

      {/* Colors section */}
      <Section
        icon={<Palette className="w-4 h-4 text-slate-400" />}
        title={t('brandKit.section.colors', { n: colors.length.toString() })}
        onSave={() => save('colors', { colors })}
        busy={busy === 'colors'}
      >
        <ul className="space-y-2">
          {colors.map((color, idx) => (
            <li
              key={idx}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50"
            >
              <input
                type="color"
                value={color.hex || '#000000'}
                onChange={(e) => {
                  const copy = [...colors]
                  copy[idx] = { ...color, hex: e.target.value }
                  setColors(copy)
                }}
                className="h-8 w-10 cursor-pointer rounded"
              />
              <input
                type="text"
                value={color.hex}
                onChange={(e) => {
                  const copy = [...colors]
                  copy[idx] = { ...color, hex: e.target.value }
                  setColors(copy)
                }}
                placeholder="#FF0000"
                className="w-24 rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs uppercase dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="text"
                value={color.name}
                onChange={(e) => {
                  const copy = [...colors]
                  copy[idx] = { ...color, name: e.target.value }
                  setColors(copy)
                }}
                placeholder={t('brandKit.field.colorNamePlaceholder')}
                className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <select
                value={color.role}
                onChange={(e) => {
                  const copy = [...colors]
                  copy[idx] = { ...color, role: e.target.value as ColorRole }
                  setColors(copy)
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {COLOR_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  setColors(colors.filter((_, i) => i !== idx))
                }
                aria-label={t('common.delete')}
                className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            setColors([
              ...colors,
              { name: '', hex: '#000000', role: 'primary' },
            ])
          }
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('brandKit.field.addColor')}
        </button>
      </Section>

      {/* Fonts section */}
      <Section
        icon={<Type className="w-4 h-4 text-slate-400" />}
        title={t('brandKit.section.fonts', { n: fonts.length.toString() })}
        onSave={() => save('fonts', { fonts })}
        busy={busy === 'fonts'}
      >
        <ul className="space-y-2">
          {fonts.map((font, idx) => (
            <li
              key={idx}
              className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50 sm:grid-cols-[1fr_1fr_100px_120px_auto]"
            >
              <input
                type="text"
                value={font.name}
                onChange={(e) => {
                  const copy = [...fonts]
                  copy[idx] = { ...font, name: e.target.value }
                  setFonts(copy)
                }}
                placeholder={t('brandKit.field.fontNamePlaceholder')}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="text"
                value={font.family}
                onChange={(e) => {
                  const copy = [...fonts]
                  copy[idx] = { ...font, family: e.target.value }
                  setFonts(copy)
                }}
                placeholder="Inter, sans-serif"
                style={{ fontFamily: font.family || undefined }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="text"
                value={font.weight ?? ''}
                onChange={(e) => {
                  const copy = [...fonts]
                  copy[idx] = { ...font, weight: e.target.value }
                  setFonts(copy)
                }}
                placeholder="400"
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <select
                value={font.role}
                onChange={(e) => {
                  const copy = [...fonts]
                  copy[idx] = { ...font, role: e.target.value as FontRole }
                  setFonts(copy)
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {FONT_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  setFonts(fonts.filter((_, i) => i !== idx))
                }
                aria-label={t('common.delete')}
                className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            setFonts([
              ...fonts,
              { name: '', family: '', weight: '400', role: 'body' },
            ])
          }
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('brandKit.field.addFont')}
        </button>
      </Section>

      {/* Logos section */}
      <Section
        icon={<ImageIcon className="w-4 h-4 text-slate-400" />}
        title={t('brandKit.section.logos', { n: logos.length.toString() })}
        onSave={() => save('logos', { logos })}
        busy={busy === 'logos'}
      >
        <ul className="space-y-2">
          {logos.map((logo, idx) => (
            <li
              key={idx}
              className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50"
            >
              <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded bg-white dark:bg-slate-900">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {logo.url ? (
                  <img
                    src={logo.url}
                    alt={logo.name}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-slate-400">
                    <ImageIcon className="w-4 h-4" />
                  </div>
                )}
              </div>
              <input
                type="text"
                value={logo.name}
                onChange={(e) => {
                  const copy = [...logos]
                  copy[idx] = { ...logo, name: e.target.value }
                  setLogos(copy)
                }}
                placeholder={t('brandKit.field.logoNamePlaceholder')}
                className="w-32 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <input
                type="url"
                value={logo.url ?? ''}
                onChange={(e) => {
                  const copy = [...logos]
                  copy[idx] = { ...logo, url: e.target.value }
                  setLogos(copy)
                }}
                placeholder={t('brandKit.field.logoUrlPlaceholder')}
                className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <select
                value={logo.role}
                onChange={(e) => {
                  const copy = [...logos]
                  copy[idx] = { ...logo, role: e.target.value as LogoRole }
                  setLogos(copy)
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              >
                {LOGO_ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  setLogos(logos.filter((_, i) => i !== idx))
                }
                aria-label={t('common.delete')}
                className="rounded p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() =>
            setLogos([...logos, { name: '', url: '', role: 'primary' }])
          }
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Plus className="w-3 h-3" />
          {t('brandKit.field.addLogo')}
        </button>
      </Section>

      {/* Notes */}
      <Section
        icon={<Quote className="w-4 h-4 text-slate-400" />}
        title={t('brandKit.section.notes')}
        onSave={() => save('notes', { notes })}
        busy={busy === 'notes'}
      >
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('brandKit.field.notesPlaceholder')}
          rows={5}
          className="w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
      </Section>

      {/* MC.10.3 — Watermarks. Rendered as its own section because
          it has its own CRUD endpoints (each watermark is a row,
          not a field on BrandKit). Only meaningful once the kit
          has been saved at least once — the API returns 404 for
          orphan brands. */}
      {!isNew && (
        <WatermarksSection brand={brand} apiBase={apiBase} />
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  onSave,
  busy,
  children,
}: {
  icon: React.ReactNode
  title: string
  onSave: () => void
  busy: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslations()
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
          {icon}
          {title}
        </h2>
        <Button
          variant="primary"
          size="sm"
          onClick={onSave}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5 mr-1" />
          )}
          {t('common.save')}
        </Button>
      </header>
      <div className="space-y-3">{children}</div>
    </section>
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
