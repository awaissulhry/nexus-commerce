'use client'

/**
 * W12 — SEO tab on /products/[id]/edit.
 *
 * Per-locale SEO metadata editor:
 *   - Meta title (60-char SERP limit), meta description (160-char limit)
 *   - URL handle (slug), canonical URL override
 *   - Open Graph overrides (og:title, og:description, og:image)
 *   - Live SERP snippet preview (desktop + mobile)
 *   - schema.org Product JSON-LD auto-generated preview with copy button
 *   - Locale switcher (add / delete locales)
 *
 * All changes are saved immediately on blur (per-field PUT /api/products/:id/seo/:locale).
 * The tab reports dirty during an in-flight save only.
 *
 * schema.org generation is client-side only (no extra server call):
 * it assembles a Product JSON-LD from the master product fields + SEO
 * row so the operator can paste it into Shopify's custom liquid or
 * a static headless storefront.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Globe,
  Loader2,
  Monitor,
  Plus,
  Smartphone,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────

interface ProductSeo {
  id: string
  productId: string
  locale: string
  metaTitle: string | null
  metaDescription: string | null
  urlHandle: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImageUrl: string | null
  canonicalUrl: string | null
  schemaOrgJson: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

interface ProductStub {
  id: string
  sku: string
  name: string
  description: string | null
  basePrice: number
  brand: string | null
  gtin: string | null
  countryOfOrigin: string | null
}

interface SeoTabProps {
  product: ProductStub
  discardSignal: number
  onDirtyChange: (count: number) => void
}

// ── Constants ──────────────────────────────────────────────────────────

const SERP_TITLE_MAX = 60
const SERP_DESC_MAX = 160

const KNOWN_LOCALES = [
  { code: 'default', label: 'Default (canonical)' },
  { code: 'it', label: 'Italian (it)' },
  { code: 'en', label: 'English (en)' },
  { code: 'de', label: 'German (de)' },
  { code: 'fr', label: 'French (fr)' },
  { code: 'es', label: 'Spanish (es)' },
  { code: 'pl', label: 'Polish (pl)' },
  { code: 'nl', label: 'Dutch (nl)' },
  { code: 'sv', label: 'Swedish (sv)' },
]

// ── Helpers ────────────────────────────────────────────────────────────

function charCount(value: string | null, max: number) {
  const len = (value ?? '').length
  const pct = len / max
  if (len === 0) return { len, cls: 'text-slate-400' }
  if (pct > 1) return { len, cls: 'text-red-600 dark:text-red-400 font-semibold' }
  if (pct > 0.9) return { len, cls: 'text-amber-600 dark:text-amber-400' }
  return { len, cls: 'text-emerald-600 dark:text-emerald-400' }
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u').replace(/[ñ]/g, 'n').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function buildSchemaOrg(product: ProductStub, seo: Partial<ProductSeo> | null): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: seo?.metaTitle ?? product.name,
    description: seo?.metaDescription ?? (product.description?.replace(/<[^>]*>/g, '') ?? ''),
    sku: product.sku,
    ...(product.gtin && { gtin: product.gtin }),
    ...(product.brand && {
      brand: { '@type': 'Brand', name: product.brand },
    }),
    ...(product.countryOfOrigin && { countryOfOrigin: product.countryOfOrigin }),
    ...(seo?.ogImageUrl && { image: seo.ogImageUrl }),
    offers: {
      '@type': 'Offer',
      priceCurrency: 'EUR',
      price: product.basePrice.toFixed(2),
      availability: 'https://schema.org/InStock',
      itemCondition: 'https://schema.org/NewCondition',
    },
  }
}

// ── Character counter bar ───────────────────────────────────────────────

function CharBar({ value, max }: { value: string | null; max: number }) {
  const len = (value ?? '').length
  const pct = Math.min(len / max, 1)
  const { cls } = charCount(value, max)
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            len === 0 ? 'bg-slate-200 dark:bg-slate-700' :
            pct > 1 ? 'bg-red-500' :
            pct > 0.9 ? 'bg-amber-400' :
            'bg-emerald-400',
          )}
          style={{ width: `${Math.min(pct * 100, 100)}%` }}
        />
      </div>
      <span className={cn('text-xs tabular-nums', cls)}>{len}/{max}</span>
    </div>
  )
}

// ── SERP Preview ─────────────────────────────────────────────────────────

function SerpPreview({
  title,
  description,
  urlHandle,
  product,
  mobile,
}: {
  title: string | null
  description: string | null
  urlHandle: string | null
  product: ProductStub
  mobile: boolean
}) {
  const displayTitle = title || product.name
  const displayDesc = description || (product.description?.replace(/<[^>]*>/g, '') ?? '')
  const slug = urlHandle || slugify(product.name)
  const domain = 'yourdomain.com'
  const url = `${domain} › products › ${slug}`

  return (
    <div className={cn(
      'border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-white dark:bg-slate-900',
      mobile ? 'max-w-sm' : 'max-w-2xl',
    )}>
      <p className="text-xs text-slate-400 mb-2">
        {mobile ? <Smartphone className="w-3 h-3 inline mr-1" /> : <Monitor className="w-3 h-3 inline mr-1" />}
        SERP preview ({mobile ? 'mobile' : 'desktop'})
      </p>
      <div className="space-y-0.5">
        <p className="text-xs text-emerald-700 dark:text-emerald-400 truncate">{url}</p>
        <p className={cn(
          'font-medium text-blue-700 dark:text-blue-400 leading-snug',
          mobile ? 'text-base' : 'text-lg',
        )} style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {displayTitle.slice(0, 60)}{displayTitle.length > 60 ? '…' : ''}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-snug"
          style={{ display: '-webkit-box', WebkitLineClamp: mobile ? 2 : 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {displayDesc.slice(0, 160)}{displayDesc.length > 160 ? '…' : ''}
        </p>
      </div>
    </div>
  )
}

// ── Locale editor pane ───────────────────────────────────────────────────

interface LocaleEditorProps {
  seo: Partial<ProductSeo> | null
  locale: string
  product: ProductStub
  onSave: (locale: string, field: string, value: string | null) => void
  onDelete: (locale: string) => void
  isSaving: boolean
}

function LocaleEditor({ seo, locale, product, onSave, onDelete, isSaving }: LocaleEditorProps) {
  const { t } = useTranslations()
  const [metaTitle, setMetaTitle] = useState(seo?.metaTitle ?? '')
  const [metaDescription, setMetaDescription] = useState(seo?.metaDescription ?? '')
  const [urlHandle, setUrlHandle] = useState(seo?.urlHandle ?? '')
  const [canonicalUrl, setCanonicalUrl] = useState(seo?.canonicalUrl ?? '')
  const [ogTitle, setOgTitle] = useState(seo?.ogTitle ?? '')
  const [ogDescription, setOgDescription] = useState(seo?.ogDescription ?? '')
  const [ogImageUrl, setOgImageUrl] = useState(seo?.ogImageUrl ?? '')
  const [showOg, setShowOg] = useState(false)
  const [showSchema, setShowSchema] = useState(false)
  const [schemaCopied, setSchemaCopied] = useState(false)
  const [serpView, setSerpView] = useState<'desktop' | 'mobile'>('desktop')

  const schemaJson = buildSchemaOrg(product, { ...seo, metaTitle: metaTitle || seo?.metaTitle || null, metaDescription: metaDescription || seo?.metaDescription || null, ogImageUrl: ogImageUrl || seo?.ogImageUrl || null })
  const schemaStr = JSON.stringify(schemaJson, null, 2)

  function handleBlur(field: string, value: string) {
    onSave(locale, field, value.trim() || null)
  }

  async function copySchema() {
    await navigator.clipboard.writeText(
      `<script type="application/ld+json">\n${schemaStr}\n</script>`,
    )
    setSchemaCopied(true)
    setTimeout(() => setSchemaCopied(false), 2000)
  }

  const inputCls = 'w-full rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400'
  const labelCls = 'block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1'

  return (
    <div className="space-y-5">
      {/* SERP preview */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            {t('products.edit.seo.serpPreview')}
          </h3>
          <div className="flex border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden text-xs">
            <button
              onClick={() => setSerpView('desktop')}
              className={cn('px-2 py-1 flex items-center gap-1',
                serpView === 'desktop' ? 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200' : 'text-slate-500')}
            >
              <Monitor className="w-3 h-3" /> Desktop
            </button>
            <button
              onClick={() => setSerpView('mobile')}
              className={cn('px-2 py-1 flex items-center gap-1',
                serpView === 'mobile' ? 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200' : 'text-slate-500')}
            >
              <Smartphone className="w-3 h-3" /> Mobile
            </button>
          </div>
        </div>
        <SerpPreview
          title={metaTitle || null}
          description={metaDescription || null}
          urlHandle={urlHandle || null}
          product={product}
          mobile={serpView === 'mobile'}
        />
      </div>

      {/* Meta title */}
      <div>
        <label className={labelCls}>{t('products.edit.seo.metaTitle')}</label>
        <input
          value={metaTitle}
          onChange={(e) => setMetaTitle(e.target.value)}
          onBlur={(e) => handleBlur('metaTitle', e.target.value)}
          placeholder={product.name}
          maxLength={80}
          className={inputCls}
        />
        <CharBar value={metaTitle} max={SERP_TITLE_MAX} />
      </div>

      {/* Meta description */}
      <div>
        <label className={labelCls}>{t('products.edit.seo.metaDescription')}</label>
        <textarea
          value={metaDescription}
          onChange={(e) => setMetaDescription(e.target.value)}
          onBlur={(e) => handleBlur('metaDescription', e.target.value)}
          placeholder={product.description?.replace(/<[^>]*>/g, '').slice(0, 160) ?? ''}
          rows={3}
          maxLength={250}
          className={inputCls}
        />
        <CharBar value={metaDescription} max={SERP_DESC_MAX} />
      </div>

      {/* URL handle */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls}>{t('products.edit.seo.urlHandle')}</label>
          <div className="flex items-center">
            <span className="rounded-l-md border border-r-0 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-2 text-xs text-slate-400">/</span>
            <input
              value={urlHandle}
              onChange={(e) => setUrlHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              onBlur={(e) => handleBlur('urlHandle', e.target.value)}
              placeholder={slugify(product.name)}
              className="flex-1 rounded-r-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('products.edit.seo.canonicalUrl')}</label>
          <input
            value={canonicalUrl}
            onChange={(e) => setCanonicalUrl(e.target.value)}
            onBlur={(e) => handleBlur('canonicalUrl', e.target.value)}
            placeholder="https://…"
            className={inputCls}
          />
        </div>
      </div>

      {/* Open Graph (collapsible) */}
      <div>
        <button
          onClick={() => setShowOg((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          {showOg ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          {t('products.edit.seo.ogSection')}
        </button>
        {showOg && (
          <div className="mt-3 space-y-3 pl-4 border-l-2 border-slate-100 dark:border-slate-800">
            <div>
              <label className={labelCls}>{t('products.edit.seo.ogTitle')}</label>
              <input value={ogTitle} onChange={(e) => setOgTitle(e.target.value)} onBlur={(e) => handleBlur('ogTitle', e.target.value)} placeholder={metaTitle || product.name} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('products.edit.seo.ogDescription')}</label>
              <textarea value={ogDescription} onChange={(e) => setOgDescription(e.target.value)} onBlur={(e) => handleBlur('ogDescription', e.target.value)} placeholder={metaDescription} rows={2} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('products.edit.seo.ogImageUrl')}</label>
              <input value={ogImageUrl} onChange={(e) => setOgImageUrl(e.target.value)} onBlur={(e) => handleBlur('ogImageUrl', e.target.value)} placeholder="https://…" className={inputCls} />
            </div>
          </div>
        )}
      </div>

      {/* schema.org JSON-LD (collapsible) */}
      <div>
        <button
          onClick={() => setShowSchema((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          {showSchema ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Code2 className="w-3.5 h-3.5" />
          {t('products.edit.seo.schemaOrg')}
        </button>
        {showSchema && (
          <div className="mt-3 space-y-2">
            <div className="relative">
              <pre className="bg-slate-900 text-slate-100 rounded-lg p-4 text-xs overflow-x-auto leading-relaxed font-mono max-h-72">
                {`<script type="application/ld+json">\n${schemaStr}\n</script>`}
              </pre>
              <button
                onClick={copySchema}
                className="absolute top-2 right-2 bg-slate-700 hover:bg-slate-600 rounded px-2 py-1 text-xs text-slate-200 flex items-center gap-1 transition-colors"
              >
                <Copy className="w-3 h-3" />
                {schemaCopied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.seo.schemaOrgHint')}
            </p>
          </div>
        )}
      </div>

      {/* Delete locale */}
      {locale !== 'default' && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button
            size="sm"
            variant="ghost"
            className="text-red-600 dark:text-red-400 hover:text-red-700 gap-1"
            onClick={() => onDelete(locale)}
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('products.edit.seo.deleteLocale')}
          </Button>
        </div>
      )}

      {isSaving && (
        <div className="flex items-center gap-1.5 text-xs text-slate-400">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t('products.edit.seo.saving')}
        </div>
      )}
    </div>
  )
}

// ── Main Tab ───────────────────────────────────────────────────────────

export default function SeoTab({ product, discardSignal, onDirtyChange }: SeoTabProps) {
  const { t } = useTranslations()

  const [seoRows, setSeoRows] = useState<ProductSeo[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedLocale, setSelectedLocale] = useState('default')
  const [saving, setSaving] = useState(false)
  const [showAddLocale, setShowAddLocale] = useState(false)
  const [newLocale, setNewLocale] = useState('')

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // SEO tab doesn't maintain local dirty state — saves on blur
  useEffect(() => { onDirtyChange(0) }, [onDirtyChange])

  const loadSeo = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/products/${product.id}/seo`)
      if (!res.ok) throw new Error()
      const rows: ProductSeo[] = await res.json()
      setSeoRows(rows)
      // Ensure 'default' locale exists in the list for the editor
      if (rows.length === 0 || !rows.find((r) => r.locale === 'default')) {
        setSelectedLocale('default')
      }
    } finally {
      setLoading(false)
    }
  }, [product.id])

  useEffect(() => { loadSeo() }, [loadSeo, discardSignal])

  async function handleSave(locale: string, field: string, value: string | null) {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setSaving(true)
    try {
      const res = await fetch(`/api/products/${product.id}/seo/${locale}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!res.ok) throw new Error()
      const updated: ProductSeo = await res.json()
      setSeoRows((prev) => {
        const exists = prev.find((r) => r.locale === locale)
        if (exists) return prev.map((r) => (r.locale === locale ? updated : r))
        return [...prev, updated]
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleAddLocale() {
    const loc = newLocale.trim().toLowerCase()
    if (!loc) return
    if (seoRows.find((r) => r.locale === loc)) {
      setSelectedLocale(loc)
      setShowAddLocale(false)
      return
    }
    await handleSave(loc, 'metaTitle', null)
    setSelectedLocale(loc)
    setShowAddLocale(false)
    setNewLocale('')
  }

  async function handleDeleteLocale(locale: string) {
    if (locale === 'default') return
    await fetch(`/api/products/${product.id}/seo/${locale}`, { method: 'DELETE' })
    setSeoRows((prev) => prev.filter((r) => r.locale !== locale))
    setSelectedLocale('default')
  }

  const currentSeo = seoRows.find((r) => r.locale === selectedLocale) ?? null
  const presentLocales = [...new Set(['default', ...seoRows.map((r) => r.locale)])]

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
          <Globe className="w-4 h-4 text-blue-500" />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.seo.title')}
          </h2>
          <div className="ml-auto flex items-center gap-2">
            {/* Locale tabs */}
            <div className="flex items-center gap-1">
              {presentLocales.map((loc) => (
                <button
                  key={loc}
                  onClick={() => setSelectedLocale(loc)}
                  className={cn(
                    'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    selectedLocale === loc
                      ? 'bg-blue-500 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700',
                  )}
                >
                  {loc === 'default' ? 'Default' : loc.toUpperCase()}
                </button>
              ))}
              <button
                onClick={() => setShowAddLocale((v) => !v)}
                className="w-6 h-6 flex items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
                title={t('products.edit.seo.addLocale')}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Add locale inline */}
        {showAddLocale && (
          <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 bg-slate-50 dark:bg-slate-800/40">
            <select
              value={newLocale}
              onChange={(e) => setNewLocale(e.target.value)}
              className="text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 focus:outline-none"
            >
              <option value="">{t('products.edit.seo.selectLocale')}</option>
              {KNOWN_LOCALES.filter((l) => l.code !== 'default' && !seoRows.find((r) => r.locale === l.code)).map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <input
              value={newLocale}
              onChange={(e) => setNewLocale(e.target.value.toLowerCase())}
              placeholder="or type locale code…"
              className="flex-1 text-sm border border-slate-200 dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 focus:outline-none"
            />
            <Button size="sm" onClick={handleAddLocale} disabled={!newLocale}>Add</Button>
            <IconButton size="sm" aria-label="Close" onClick={() => setShowAddLocale(false)}><span className="text-xs">✕</span></IconButton>
          </div>
        )}

        <div className="px-5 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading SEO data…
            </div>
          ) : (
            <LocaleEditor
              key={selectedLocale}
              seo={currentSeo}
              locale={selectedLocale}
              product={product}
              onSave={handleSave}
              onDelete={handleDeleteLocale}
              isSaving={saving}
            />
          )}
        </div>
      </div>
    </div>
  )
}
