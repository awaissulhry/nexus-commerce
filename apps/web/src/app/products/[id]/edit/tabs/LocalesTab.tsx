'use client'

/**
 * W4.1 — Locales tab on /products/[id]/edit (Akeneo cornerstone).
 *
 * Side-by-side translation editor: master row on the left (read-
 * only, source of truth), per-locale translation on the right
 * (editable). Each non-primary locale lives in ProductTranslation
 * (H.10) and falls back to master when not present.
 *
 * The audit found 1/281 products had any translation at all. With
 * Xavia listed across 9 marketplaces (IT, DE, FR, UK, ES, NL, PL,
 * SE, US) and channels falling back to it_IT for everything missing,
 * the operator was effectively shipping Italian copy worldwide.
 *
 * This tab gives:
 *   - per-locale completeness scoring (4 fields: name, description,
 *     bullets, keywords)
 *   - source provenance badge (manual / ai-gemini / ai-anthropic /
 *     translated)
 *   - reviewedAt indicator (AI-generated needs eyes before public)
 *   - inline side-by-side edit with auto-save 600ms debounced
 *   - mark-reviewed action
 *   - delete-translation action (channels fall back to master)
 *
 * AI translate per field is W4.2; bulk translate-all-locales is
 * W4.3; this commit is the read-write foundation.
 *
 * Discard semantics: each draft locale tracks its own dirty count
 * via the discardSignal mechanism, mirroring MasterDataTab.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  Globe,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

const SUPPORTED_LOCALES = ['en', 'de', 'fr', 'es', 'nl', 'pl', 'sv'] as const

const LOCALE_DISPLAY: Record<string, { flag: string; label: string }> = {
  it: { flag: '🇮🇹', label: 'Italiano' },
  en: { flag: '🇬🇧', label: 'English' },
  de: { flag: '🇩🇪', label: 'Deutsch' },
  fr: { flag: '🇫🇷', label: 'Français' },
  es: { flag: '🇪🇸', label: 'Español' },
  nl: { flag: '🇳🇱', label: 'Nederlands' },
  pl: { flag: '🇵🇱', label: 'Polski' },
  sv: { flag: '🇸🇪', label: 'Svenska' },
}

interface TranslationRow {
  id: string
  productId: string
  language: string
  name: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  source: string | null
  sourceModel: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}

interface Props {
  product: any
  onDirtyChange: (count: number) => void
  discardSignal: number
}

const SAVE_DEBOUNCE_MS = 600

interface DraftState {
  name: string
  description: string
  bulletPoints: string // newline-separated
  keywords: string // newline-separated
}

function rowToDraft(row: TranslationRow): DraftState {
  return {
    name: row.name ?? '',
    description: row.description ?? '',
    bulletPoints: (row.bulletPoints ?? []).join('\n'),
    keywords: (row.keywords ?? []).join('\n'),
  }
}

function emptyDraft(): DraftState {
  return { name: '', description: '', bulletPoints: '', keywords: '' }
}

function completenessOf(draft: DraftState): number {
  let n = 0
  if (draft.name.trim().length > 0) n += 25
  if (draft.description.trim().length > 0) n += 25
  if (draft.bulletPoints.trim().length > 0) n += 25
  if (draft.keywords.trim().length > 0) n += 25
  return n
}

function masterDraft(product: any): DraftState {
  return {
    name: product.name ?? '',
    description: product.description ?? '',
    bulletPoints: Array.isArray(product.bulletPoints)
      ? product.bulletPoints.join('\n')
      : '',
    keywords: Array.isArray(product.keywords)
      ? product.keywords.join('\n')
      : '',
  }
}

export default function LocalesTab({
  product,
  onDirtyChange,
  discardSignal,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()

  const [primaryLanguage, setPrimaryLanguage] = useState<string>('it')
  const [translations, setTranslations] = useState<TranslationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Record<string, DraftState>>({})
  // Per-locale dirty bit. Aggregated for parent's "{n} unsaved" badge.
  const dirtyMapRef = useRef<Record<string, Set<keyof DraftState>>>({})
  const saveTimers = useRef<Record<string, number | null>>({})
  const [statusByLocale, setStatusByLocale] = useState<
    Record<string, 'idle' | 'saving' | 'saved' | 'error'>
  >({})
  // W4.2 — per-locale AI translate busy flag.
  const [translatingLocale, setTranslatingLocale] = useState<string | null>(
    null,
  )
  // W4.3 — bulk-translate progress. null when idle, otherwise tracks
  // current/total + the locale currently in flight so the CTA can
  // show running progress instead of a frozen spinner.
  const [bulkProgress, setBulkProgress] = useState<{
    current: number
    total: number
    locale: string
  } | null>(null)

  const reportDirty = useCallback(() => {
    let n = 0
    for (const set of Object.values(dirtyMapRef.current)) n += set.size
    onDirtyChange(n)
  }, [onDirtyChange])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/translations`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as {
        primaryLanguage: string
        translations: TranslationRow[]
      }
      setPrimaryLanguage(json.primaryLanguage ?? 'it')
      setTranslations(json.translations ?? [])
      // Reseed drafts from server data, preserving any in-flight
      // edits the user has made (their dirty set survives).
      setDrafts((prev) => {
        const next: Record<string, DraftState> = {}
        for (const row of json.translations ?? []) {
          if (dirtyMapRef.current[row.language]?.size) {
            next[row.language] = prev[row.language] ?? rowToDraft(row)
          } else {
            next[row.language] = rowToDraft(row)
          }
        }
        return next
      })
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setLoading(false)
    }
  }, [product.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Discard handling — drop dirty sets, cancel timers, reset drafts.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    for (const tid of Object.values(saveTimers.current)) {
      if (tid) globalThis.clearTimeout(tid)
    }
    saveTimers.current = {}
    dirtyMapRef.current = {}
    reportDirty()
    void refresh()
  }, [discardSignal, refresh, reportDirty])

  // Cleanup-flush on unmount: any half-typed locale fields flush so
  // tab switches don't drop edits silently. discardSignal handler
  // clears the dirty refs first so a Discard click is a true no-op.
  useEffect(() => {
    return () => {
      for (const tid of Object.values(saveTimers.current)) {
        if (tid) globalThis.clearTimeout(tid)
      }
      // Best-effort flush: fire and forget. The component is gone
      // so we don't await — the API still receives the PUT.
      for (const [lang, set] of Object.entries(dirtyMapRef.current)) {
        if (set.size === 0) continue
        const draft = drafts[lang]
        if (!draft) continue
        void flushLocale(lang, draft)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flushLocale = useCallback(
    async (language: string, draft: DraftState) => {
      const dirty = dirtyMapRef.current[language]
      if (!dirty || dirty.size === 0) return
      const body: Record<string, unknown> = { source: 'manual' }
      if (dirty.has('name')) body.name = draft.name.trim() || null
      if (dirty.has('description')) {
        body.description = draft.description.trim() || null
      }
      if (dirty.has('bulletPoints')) {
        body.bulletPoints = draft.bulletPoints
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }
      if (dirty.has('keywords')) {
        body.keywords = draft.keywords
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      }
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${product.id}/translations/${language}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        if (!res.ok) {
          const j = await res.json().catch(() => null)
          throw new Error(j?.error ?? `HTTP ${res.status}`)
        }
        const updated = (await res.json()) as TranslationRow
        dirtyMapRef.current[language] = new Set()
        reportDirty()
        setStatusByLocale((p) => ({ ...p, [language]: 'saved' }))
        globalThis.setTimeout(() => {
          setStatusByLocale((p) =>
            p[language] === 'saved' ? { ...p, [language]: 'idle' } : p,
          )
        }, 1500)
        // Patch the row in-place so reviewedAt + source badge update
        // without a full refetch.
        setTranslations((prev) => {
          const idx = prev.findIndex((r) => r.language === language)
          if (idx === -1) return [...prev, updated]
          const next = prev.slice()
          next[idx] = updated
          return next
        })
      } catch (e: any) {
        setStatusByLocale((p) => ({ ...p, [language]: 'error' }))
        toast.error(
          t('products.edit.locales.saveFailed', {
            error: e?.message ?? String(e),
          }),
        )
      }
    },
    [product.id, reportDirty, t, toast],
  )

  const updateField = (
    language: string,
    field: keyof DraftState,
    value: string,
  ) => {
    setDrafts((prev) => ({
      ...prev,
      [language]: { ...(prev[language] ?? emptyDraft()), [field]: value },
    }))
    if (!dirtyMapRef.current[language]) {
      dirtyMapRef.current[language] = new Set()
    }
    dirtyMapRef.current[language].add(field)
    reportDirty()
    setStatusByLocale((p) => ({ ...p, [language]: 'saving' }))
    if (saveTimers.current[language]) {
      globalThis.clearTimeout(saveTimers.current[language]!)
    }
    saveTimers.current[language] = globalThis.setTimeout(() => {
      // Read latest draft via state — flushLocale captures from the
      // closure but state may have re-rendered between debounce
      // schedule and fire. Using a setter+ref read gives latest.
      setDrafts((latest) => {
        const draft = { ...(latest[language] ?? emptyDraft()), [field]: value }
        void flushLocale(language, draft)
        return latest
      })
    }, SAVE_DEBOUNCE_MS) as unknown as number
  }

  const onAddLocale = async (language: string) => {
    const lang = language.toLowerCase()
    if (lang === primaryLanguage) {
      toast.error(t('products.edit.locales.cannotAddPrimary'))
      return
    }
    try {
      // Empty PUT seeds a row with manual source. Operator can fill in
      // from there. Backend rejects writes to primary language with 400.
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/translations/${lang}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: null,
            description: null,
            bulletPoints: [],
            keywords: [],
            source: 'manual',
          }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.locales.added'))
      setExpanded((p) => {
        const n = new Set(p)
        n.add(lang)
        return n
      })
      void refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.locales.addFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  // W4.2 — AI translate the entire locale via Gemini. Writes back to
  // ProductTranslation server-side; we just refetch + reseed the
  // draft. Any in-flight dirty edits on this locale are cleared
  // before the AI write to avoid a stale-overwrite race.
  const onAiTranslate = async (language: string) => {
    setTranslatingLocale(language)
    try {
      // Clear pending debounce + dirty for this locale so AI result
      // wins cleanly and doesn't get clobbered by a delayed flush.
      const tid = saveTimers.current[language]
      if (tid) globalThis.clearTimeout(tid)
      saveTimers.current[language] = null
      delete dirtyMapRef.current[language]
      reportDirty()

      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/translations/${language}/ai-translate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: ['title', 'bullets', 'description', 'keywords'],
          }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as {
        row: TranslationRow
        fieldsTranslated: string[]
        fieldsSkipped: string[]
      }
      const translated = json.fieldsTranslated.length
      const skipped = json.fieldsSkipped.length
      if (translated === 0) {
        toast.error(
          t('products.edit.locales.aiAllSkipped', { count: skipped }),
        )
      } else if (skipped === 0) {
        toast.success(
          t('products.edit.locales.aiSuccess', { count: translated }),
        )
      } else {
        toast.success(
          t('products.edit.locales.aiPartial', {
            translated,
            skipped,
          }),
        )
      }
      // Reseed the draft + row from server so the editor reflects AI
      // output immediately.
      setTranslations((prev) => {
        const idx = prev.findIndex((r) => r.language === language)
        if (idx === -1) return [...prev, json.row]
        const next = prev.slice()
        next[idx] = json.row
        return next
      })
      setDrafts((prev) => ({ ...prev, [language]: rowToDraft(json.row) }))
      // Auto-expand so the operator can review immediately.
      setExpanded((p) => {
        const n = new Set(p)
        n.add(language)
        return n
      })
    } catch (e: any) {
      toast.error(
        t('products.edit.locales.aiFailed', {
          error: e?.message ?? String(e),
        }),
      )
    } finally {
      setTranslatingLocale(null)
    }
  }

  // W4.3 — bulk-translate: iterate every supported locale that lacks
  // a translation row and call the per-locale AI endpoint serially.
  // Serial (not parallel) keeps us inside the provider's rate limit
  // and gives the operator a clear "X of Y" progress indicator. Each
  // locale's row is patched in-place as it lands so the list grows
  // visibly. Failures don't abort — they're collected and reported
  // alongside the success count at the end.
  const onBulkTranslate = async (targets: string[]) => {
    if (targets.length === 0) return
    let succeeded = 0
    let failed: string[] = []
    let totalTranslated = 0
    for (let i = 0; i < targets.length; i++) {
      const lang = targets[i]
      setBulkProgress({ current: i + 1, total: targets.length, locale: lang })
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${product.id}/translations/${lang}/ai-translate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fields: ['title', 'bullets', 'description', 'keywords'],
            }),
          },
        )
        if (!res.ok) {
          failed.push(lang)
          continue
        }
        const json = (await res.json()) as {
          row: TranslationRow
          fieldsTranslated: string[]
        }
        succeeded++
        totalTranslated += json.fieldsTranslated.length
        setTranslations((prev) => {
          const idx = prev.findIndex((r) => r.language === lang)
          if (idx === -1) return [...prev, json.row]
          const next = prev.slice()
          next[idx] = json.row
          return next
        })
        setDrafts((prev) => ({ ...prev, [lang]: rowToDraft(json.row) }))
      } catch {
        failed.push(lang)
      }
    }
    setBulkProgress(null)
    if (succeeded > 0 && failed.length === 0) {
      toast.success(
        t('products.edit.locales.bulkSuccess', {
          count: succeeded,
          fields: totalTranslated,
        }),
      )
    } else if (succeeded > 0 && failed.length > 0) {
      toast.success(
        t('products.edit.locales.bulkPartial', {
          succeeded,
          failed: failed.length,
          locales: failed.join(', ').toUpperCase(),
        }),
      )
    } else {
      toast.error(
        t('products.edit.locales.bulkAllFailed', {
          locales: failed.join(', ').toUpperCase(),
        }),
      )
    }
  }

  const onMarkReviewed = async (language: string) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/translations/${language}/review`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('products.edit.locales.markedReviewed'))
      void refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.locales.reviewFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  const onDelete = async (row: TranslationRow) => {
    const ok = await confirm({
      title: t('products.edit.locales.deleteTitle', {
        locale: row.language.toUpperCase(),
      }),
      description: t('products.edit.locales.deleteBody'),
      confirmLabel: t('products.edit.locales.deleteConfirm'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}/translations/${row.language}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      // Drop any pending dirty / draft / timer for that locale.
      delete dirtyMapRef.current[row.language]
      const tid = saveTimers.current[row.language]
      if (tid) globalThis.clearTimeout(tid)
      delete saveTimers.current[row.language]
      setDrafts((p) => {
        const n = { ...p }
        delete n[row.language]
        return n
      })
      reportDirty()
      toast.success(t('products.edit.locales.deleted'))
      void refresh()
    } catch (e: any) {
      toast.error(
        t('products.edit.locales.deleteFailed', {
          error: e?.message ?? String(e),
        }),
      )
    }
  }

  const toggle = (lang: string) => {
    setExpanded((p) => {
      const n = new Set(p)
      if (n.has(lang)) n.delete(lang)
      else n.add(lang)
      return n
    })
  }

  const master = useMemo(() => masterDraft(product), [product])
  const masterCompleteness = completenessOf(master)

  const localesWithRow = new Set(translations.map((r) => r.language))
  const addable = SUPPORTED_LOCALES.filter(
    (l) => l !== primaryLanguage && !localesWithRow.has(l),
  )

  return (
    <div className="space-y-4">
      {/* ── Master locale (read-only reference) ──────────────── */}
      <Card
        title={t('products.edit.locales.masterTitle')}
        description={t('products.edit.locales.masterDesc')}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-2xl">
            {LOCALE_DISPLAY[primaryLanguage]?.flag ?? '🌐'}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-md font-medium text-slate-900 dark:text-slate-100">
              {LOCALE_DISPLAY[primaryLanguage]?.label ??
                primaryLanguage.toUpperCase()}{' '}
              <span className="text-slate-500 dark:text-slate-400 font-normal">
                · {primaryLanguage.toUpperCase()}
              </span>
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {t('products.edit.locales.masterHint')}
            </div>
          </div>
          <CompletenessBadge percent={masterCompleteness} t={t} />
        </div>
      </Card>

      {/* ── Add locale + bulk AI translate ───────────────────── */}
      {addable.length > 0 && (
        <Card
          title={t('products.edit.locales.addTitle')}
          description={t('products.edit.locales.addDesc')}
          action={
            <Button
              variant="primary"
              size="sm"
              loading={bulkProgress !== null}
              icon={<Sparkles className="w-3.5 h-3.5" />}
              onClick={() => void onBulkTranslate([...addable])}
              title={t('products.edit.locales.bulkTooltip', {
                count: addable.length,
              })}
            >
              {bulkProgress
                ? t('products.edit.locales.bulkProgress', {
                    current: bulkProgress.current,
                    total: bulkProgress.total,
                    locale: bulkProgress.locale.toUpperCase(),
                  })
                : t('products.edit.locales.bulkButton', {
                    count: addable.length,
                  })}
            </Button>
          }
        >
          <div className="flex items-center gap-2 flex-wrap">
            {addable.map((l) => (
              <Button
                key={l}
                variant="secondary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => void onAddLocale(l)}
                disabled={bulkProgress !== null}
              >
                <span className="mr-1">{LOCALE_DISPLAY[l]?.flag}</span>
                {LOCALE_DISPLAY[l]?.label} · {l.toUpperCase()}
              </Button>
            ))}
          </div>
        </Card>
      )}

      {/* ── Translations list / editor ───────────────────────── */}
      {error ? (
        <Card>
          <div className="text-sm text-rose-700 dark:text-rose-300 inline-flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {error}
          </div>
        </Card>
      ) : loading ? (
        <Card>
          <div className="text-sm italic text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t('products.edit.locales.loading')}
          </div>
        </Card>
      ) : translations.length === 0 ? (
        <Card>
          <div className="text-sm italic text-slate-500 dark:text-slate-400 border border-dashed border-slate-200 dark:border-slate-800 rounded p-6 text-center space-y-3">
            <Globe className="w-8 h-8 mx-auto text-slate-300 dark:text-slate-600" />
            <div>{t('products.edit.locales.empty')}</div>
            {addable.length > 0 && (
              <div className="pt-2">
                <Button
                  variant="primary"
                  size="sm"
                  loading={bulkProgress !== null}
                  icon={<Sparkles className="w-3.5 h-3.5" />}
                  onClick={() => void onBulkTranslate([...addable])}
                >
                  {bulkProgress
                    ? t('products.edit.locales.bulkProgress', {
                        current: bulkProgress.current,
                        total: bulkProgress.total,
                        locale: bulkProgress.locale.toUpperCase(),
                      })
                    : t('products.edit.locales.bulkEmptyCta', {
                        count: addable.length,
                      })}
                </Button>
              </div>
            )}
          </div>
        </Card>
      ) : (
        <div className="space-y-3">
          {translations.map((row) => {
            const draft = drafts[row.language] ?? rowToDraft(row)
            const completeness = completenessOf(draft)
            const isOpen = expanded.has(row.language)
            const status = statusByLocale[row.language] ?? 'idle'
            const dirty =
              (dirtyMapRef.current[row.language]?.size ?? 0) > 0
            return (
              <Card key={row.id} noPadding>
                <button
                  type="button"
                  onClick={() => toggle(row.language)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
                >
                  <span className="text-slate-400 dark:text-slate-600 flex-shrink-0">
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4" />
                    ) : (
                      <ChevronRight className="w-4 h-4" />
                    )}
                  </span>
                  <span className="text-2xl flex-shrink-0">
                    {LOCALE_DISPLAY[row.language]?.flag ?? '🌐'}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-md font-medium text-slate-900 dark:text-slate-100">
                      {LOCALE_DISPLAY[row.language]?.label ??
                        row.language.toUpperCase()}{' '}
                      <span className="font-normal text-slate-500 dark:text-slate-400">
                        · {row.language.toUpperCase()}
                      </span>
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      {row.name ? row.name : t('products.edit.locales.untitled')}
                    </span>
                  </span>
                  <SourceBadge source={row.source} model={row.sourceModel} t={t} />
                  <ReviewBadge
                    reviewedAt={row.reviewedAt}
                    source={row.source}
                    t={t}
                  />
                  <CompletenessBadge percent={completeness} t={t} />
                  {dirty && (
                    <Badge variant="warning">
                      {status === 'saving'
                        ? t('products.edit.locales.saving')
                        : t('products.edit.locales.dirty')}
                    </Badge>
                  )}
                  {status === 'saved' && !dirty && (
                    <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1 text-xs">
                      <CheckCircle2 className="w-3 h-3" />
                      {t('products.edit.locales.saved')}
                    </span>
                  )}
                </button>

                {isOpen && (
                  <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FieldPair
                        label={t('products.edit.locales.fieldName')}
                        master={master.name}
                        masterEmpty={t('products.edit.locales.masterEmpty')}
                        value={draft.name}
                        onChange={(v) =>
                          updateField(row.language, 'name', v)
                        }
                        as="input"
                      />
                      <FieldPair
                        label={t('products.edit.locales.fieldDescription')}
                        master={master.description}
                        masterEmpty={t('products.edit.locales.masterEmpty')}
                        value={draft.description}
                        onChange={(v) =>
                          updateField(row.language, 'description', v)
                        }
                        as="textarea"
                        rows={5}
                      />
                      <FieldPair
                        label={t('products.edit.locales.fieldBullets')}
                        hint={t('products.edit.locales.bulletsHint')}
                        master={master.bulletPoints}
                        masterEmpty={t('products.edit.locales.masterEmpty')}
                        value={draft.bulletPoints}
                        onChange={(v) =>
                          updateField(row.language, 'bulletPoints', v)
                        }
                        as="textarea"
                        rows={5}
                      />
                      <FieldPair
                        label={t('products.edit.locales.fieldKeywords')}
                        hint={t('products.edit.locales.keywordsHint')}
                        master={master.keywords}
                        masterEmpty={t('products.edit.locales.masterEmpty')}
                        value={draft.keywords}
                        onChange={(v) =>
                          updateField(row.language, 'keywords', v)
                        }
                        as="textarea"
                        rows={5}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-slate-100 dark:border-slate-800">
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {row.updatedAt &&
                          t('products.edit.locales.updatedAt', {
                            when: new Date(row.updatedAt).toLocaleString(),
                          })}
                      </div>
                      <div className="flex items-center gap-2">
                        {row.source?.startsWith('ai-') && !row.reviewedAt && (
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<Eye className="w-3.5 h-3.5" />}
                            onClick={() => void onMarkReviewed(row.language)}
                          >
                            {t('products.edit.locales.markReviewed')}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={translatingLocale === row.language}
                          icon={<Sparkles className="w-3.5 h-3.5" />}
                          onClick={() => void onAiTranslate(row.language)}
                          title={t('products.edit.locales.aiTranslateTooltip', {
                            locale: row.language.toUpperCase(),
                          })}
                        >
                          {t('products.edit.locales.aiTranslate')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<Trash2 className="w-3.5 h-3.5" />}
                          onClick={() => void onDelete(row)}
                        >
                          {t('products.edit.locales.delete')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Components ─────────────────────────────────────────────────
function FieldPair({
  label,
  hint,
  master,
  masterEmpty,
  value,
  onChange,
  as,
  rows,
}: {
  label: string
  hint?: string
  master: string
  masterEmpty: string
  value: string
  onChange: (v: string) => void
  as: 'input' | 'textarea'
  rows?: number
}) {
  const masterIsEmpty = master.trim().length === 0
  return (
    <div className="space-y-1.5">
      <div className="text-base font-medium text-slate-700 dark:text-slate-300">
        {label}
      </div>
      {hint && (
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            Master · IT
          </div>
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-md whitespace-pre-wrap break-words bg-slate-50 dark:bg-slate-900/40',
              masterIsEmpty
                ? 'border-dashed border-slate-200 dark:border-slate-800 italic text-slate-500 dark:text-slate-500'
                : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300',
            )}
            style={{ minHeight: as === 'textarea' ? '8rem' : '2.25rem' }}
          >
            {masterIsEmpty ? masterEmpty : master}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
            Translation
          </div>
          {as === 'input' ? (
            <Input value={value} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <textarea
              rows={rows ?? 5}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="w-full rounded-md border border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 bg-white dark:bg-slate-900 text-md text-slate-900 dark:text-slate-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-colors font-sans"
            />
          )}
        </div>
      </div>
    </div>
  )
}

function CompletenessBadge({
  percent,
  t,
}: {
  percent: number
  t: (key: string, vars?: Record<string, string | number>) => string
}) {
  const variant: 'success' | 'warning' | 'danger' | 'default' =
    percent === 100
      ? 'success'
      : percent >= 50
        ? 'warning'
        : percent === 0
          ? 'danger'
          : 'default'
  return (
    <Badge variant={variant}>
      {t('products.edit.locales.percent', { value: percent })}
    </Badge>
  )
}

function SourceBadge({
  source,
  model,
  t,
}: {
  source: string | null
  model: string | null
  t: (key: string) => string
}) {
  if (!source) return null
  if (source === 'manual') {
    return <Badge variant="default">{t('products.edit.locales.sourceManual')}</Badge>
  }
  if (source.startsWith('ai-')) {
    const provider = source.slice(3)
    return (
      <Badge variant="info" mono>
        {provider}
        {model ? ` · ${model.split('-').slice(0, 2).join('-')}` : ''}
      </Badge>
    )
  }
  return <Badge variant="default">{source}</Badge>
}

function ReviewBadge({
  reviewedAt,
  source,
  t,
}: {
  reviewedAt: string | null
  source: string | null
  t: (key: string) => string
}) {
  if (!source?.startsWith('ai-')) return null
  if (reviewedAt) {
    return (
      <Badge variant="success">{t('products.edit.locales.reviewed')}</Badge>
    )
  }
  return <Badge variant="warning">{t('products.edit.locales.unreviewed')}</Badge>
}
