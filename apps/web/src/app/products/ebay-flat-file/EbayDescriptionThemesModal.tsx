'use client'

/**
 * ED.4 + ED v2 P3 — Description Theme manager. Two-pane modal on the eBay flat
 * file: theme list (starters + custom, with live usage counts) on the left,
 * editor + live "as pushed" preview on the right. Previews render server-side
 * via /description-preview with the UNSAVED draft html (themeHtml override),
 * so what you see is exactly what a push would send.
 *
 * ED v2 P3 additions:
 *  - product picker (GET /api/products/lookup) + market selector — preview any
 *    family × market, not just the grid's first row;
 *  - debounced auto-render on any change (theme html, product, market);
 *  - Desktop (920px, scaled to fit) / Mobile (375px) width toggle;
 *  - sandboxed iframe (srcDoc, sandbox="") so theme CSS can't leak into the app;
 *  - per-theme usage chips from GET /ebay/description-themes/usage;
 *  - themes whose notes carry a ⚠ marker surface that note as a warning banner.
 *
 * Built-in starters are editable but not deletable (the API enforces it);
 * the default theme wraps every listing that hasn't picked its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Copy, Star, Trash2, RefreshCw, Search, Monitor, Smartphone } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/design-system/components/Modal'
import { Banner } from '@/design-system/components/Banner'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { getBackendUrl } from '@/lib/backend-url'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { EBAY_MARKETPLACES } from './ebay-columns'

interface Theme {
  id: string
  name: string
  notes?: string | null
  html: string
  isDefault: boolean
  active: boolean
  builtIn: boolean
  version: number
}

interface ThemeUsage {
  total: number
  /** Listings with no explicit pick — the default theme wraps them at push. */
  default: number
  /** Listings explicitly set to 'none' — raw body on purpose. */
  raw: number
  byThemeId: Record<string, number>
}

const TOKENS = [
  '{{title}}', '{{subtitle}}', '{{body}}', '{{sku}}', '{{brand}}', '{{market}}',
  '{{gallery}}', '{{gallery_shared}}', '{{specs_table}}', '{{policies}}',
]

const DESKTOP_W = 920
const MOBILE_W = 375

// ── Preview product picker (ED v2 P3) ────────────────────────────────────────
// Same /api/products/lookup combobox pattern as the images drawer's
// "Add family" picker: family roots (parents + standalones), drafts included.

interface LookupItem {
  id: string
  sku: string
  title: string
  isParent: boolean
  hasEbayListing: boolean
}

export interface PreviewProduct { id: string; sku: string; title?: string }

function PreviewProductPicker({ selected, onSelect }: {
  selected: PreviewProduct | null
  onSelect: (p: PreviewProduct) => void
}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<LookupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setItems([]); setLoading(false); return }
    setLoading(true)
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}/api/products/lookup?q=${encodeURIComponent(term)}&limit=20`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ items: LookupItem[] }>) : null))
        .then((d) => setItems(d?.items ?? []))
        .catch(() => { /* dropdown just stays empty */ })
        .finally(() => setLoading(false))
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [q])

  const term = q.trim()
  const showDropdown = focused && term.length >= 2
  return (
    <div className="relative flex-1 min-w-0">
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        // Delay blur so a result click registers before the dropdown unmounts.
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        leadingIcon={<Search className="w-3.5 h-3.5" />}
        placeholder={selected ? `${selected.sku}${selected.title ? ` — ${selected.title}` : ''}` : 'Search a product by SKU or title…'}
        aria-label="Search a product to preview with"
      />
      {showDropdown && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Searching…
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-400">No products match "{term}".</div>
          )}
          {!loading && items.map((it) => (
            <button key={it.id} type="button"
              // onMouseDown fires before the input's blur, so the click always lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onSelect({ id: it.id, sku: it.sku, title: it.title }); setQ('') }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
              <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex-shrink-0">{it.sku}</span>
              {it.title && <span className="text-[11px] text-slate-500 dark:text-slate-400 truncate min-w-0">{it.title}</span>}
              {!it.hasEbayListing && (
                <span className="ml-auto flex-shrink-0 text-[10px] rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 font-medium"
                  title="No eBay listing yet — previews render with an empty body">
                  draft
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function EbayDescriptionThemesModal({ open, onClose, marketplace, sampleProductId, sampleProductSku, onChanged }: {
  open: boolean
  onClose: () => void
  marketplace: string
  /** A real product from the grid seeding the preview picker (first loaded family). */
  sampleProductId?: string
  /** SKU label for that product, shown in the picker until the operator changes it. */
  sampleProductSku?: string
  /** Called after any create/update/delete/default change so the page can refresh its theme list. */
  onChanged?: () => void
}) {
  const confirm = useConfirm()
  const [themes, setThemes] = useState<Theme[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ name: string; notes: string; html: string; active: boolean }>({ name: '', notes: '', html: '', active: true })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [preview, setPreview] = useState<{ html: string; warnings: string[] } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewProduct, setPreviewProduct] = useState<PreviewProduct | null>(null)
  const [previewMarket, setPreviewMarket] = useState('IT')
  const [previewWidth, setPreviewWidth] = useState<'desktop' | 'mobile'>('desktop')
  const [refreshTick, setRefreshTick] = useState(0)
  const [usage, setUsage] = useState<ThemeUsage | null>(null)
  const htmlRef = useRef<HTMLTextAreaElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const [previewBoxW, setPreviewBoxW] = useState(0)

  const selected = themes.find((t) => t.id === selectedId) ?? null
  const isNew = selectedId === null

  const load = useCallback(async (keepSelection = false) => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/ebay/description-themes`)
      const d = r.ok ? await r.json() : null
      if (d?.themes) {
        setThemes(d.themes)
        if (!keepSelection) {
          const first = (d.themes as Theme[]).find((t) => t.isDefault) ?? (d.themes as Theme[])[0]
          if (first) selectTheme(first)
        }
      }
    } catch { /* list stays empty; the error banner is only for actions */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadUsage = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/ebay/description-themes/usage`)
      const d = r.ok ? await r.json() : null
      if (d && typeof d.total === 'number') setUsage(d as ThemeUsage)
    } catch { /* chips just stay hidden */ }
  }, [])

  useEffect(() => {
    if (open) {
      setError(null); setTab('edit'); setPreview(null)
      setPreviewMarket(EBAY_MARKETPLACES.includes(marketplace) ? marketplace : 'IT')
      setPreviewProduct(sampleProductId ? { id: sampleProductId, sku: sampleProductSku ?? 'Current grid family' } : null)
      void load()
      void loadUsage()
    }
  }, [open, load, loadUsage, marketplace, sampleProductId, sampleProductSku])

  const selectTheme = (t: Theme) => {
    setSelectedId(t.id)
    setDraft({ name: t.name, notes: t.notes ?? '', html: t.html, active: t.active })
    setDirty(false)
    setPreview(null)
    setTab('edit')
  }

  const startNew = (from?: Theme) => {
    setSelectedId(null)
    setDraft({
      name: from ? `${from.name} copy` : '',
      notes: from?.notes ?? '',
      html: from?.html ?? '<div style="font-family:Arial,sans-serif;">\n  <h1>{{title}}</h1>\n  {{body}}\n  {{gallery}}\n  {{specs_table}}\n  {{policies}}\n</div>',
      active: true,
    })
    setDirty(true)
    setPreview(null)
    setTab('edit')
  }

  const save = async () => {
    if (!draft.name.trim() || !draft.html.trim()) { setError('Name and HTML are required'); return }
    setBusy(true); setError(null)
    try {
      const res = isNew
        ? await fetch(`${getBackendUrl()}/api/ebay/description-themes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: draft.name, html: draft.html, notes: draft.notes || undefined }),
          })
        : await fetch(`${getBackendUrl()}/api/ebay/description-themes/${selectedId}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: draft.name, html: draft.html, notes: draft.notes, active: draft.active }),
          })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error ?? 'Save failed')
      await load(true)
      if (d?.theme?.id) setSelectedId(d.theme.id)
      setDirty(false)
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const setDefault = async (t: Theme) => {
    setBusy(true); setError(null)
    try {
      await fetch(`${getBackendUrl()}/api/ebay/description-themes/${t.isDefault ? 'none' : t.id}/default`, { method: 'POST' })
      await load(true)
      onChanged?.()
    } finally { setBusy(false) }
  }

  const remove = async (t: Theme) => {
    const ok = await confirm({
      title: `Delete theme "${t.name}"?`,
      description: 'Listings assigned to it fall back to the default theme at the next push. This cannot be undone.',
      confirmLabel: 'Delete theme',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/description-themes/${t.id}`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error ?? 'Delete failed')
      setSelectedId(null)
      await load()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally { setBusy(false) }
  }

  // ── Live preview — debounced auto-render on ANY input change (ED v2 P3) ────
  // theme html edits, product picks, market switches and manual Refresh all
  // funnel through this one effect; the AbortController drops stale renders.
  useEffect(() => {
    if (!open || tab !== 'preview') return
    if (!previewProduct?.id || !draft.html.trim()) { setPreview(null); return }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      setPreviewBusy(true)
      try {
        const r = await fetch(`${getBackendUrl()}/api/ebay/description-preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productId: previewProduct.id, marketplace: previewMarket, mode: 'group', themeHtml: draft.html }),
          signal: ctrl.signal,
        })
        const d = r.ok ? await r.json() : null
        setPreview(d ? { html: d.html, warnings: d.warnings ?? [] } : null)
        setPreviewBusy(false)
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          setPreview(null)
          setPreviewBusy(false)
        }
      }
    }, 500)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [open, tab, previewProduct, previewMarket, draft.html, refreshTick])

  // Measure the preview pane so the 920px desktop frame scales to fit.
  useEffect(() => {
    if (!open || tab !== 'preview') return
    const el = previewBoxRef.current
    if (!el) return
    const measure = () => setPreviewBoxW(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, tab])

  // Sandboxed document: sandbox="" blocks scripts/navigation and the srcDoc
  // wrapper keeps theme CSS inside the frame instead of leaking into the app.
  const srcDoc = useMemo(() => {
    if (!preview?.html) return ''
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>html,body{margin:0;padding:0;background:#ffffff;}body{padding:12px;font-family:Arial,Helvetica,sans-serif;color:#111827;}img{max-width:100%;}</style></head><body>${preview.html}</body></html>`
  }, [preview?.html])

  const insertToken = (token: string) => {
    const el = htmlRef.current
    if (!el) return
    const start = el.selectionStart ?? draft.html.length
    const end = el.selectionEnd ?? start
    const next = draft.html.slice(0, start) + token + draft.html.slice(end)
    setDraft((d) => ({ ...d, html: next }))
    setDirty(true)
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + token.length })
  }

  const frameW = previewWidth === 'desktop' ? DESKTOP_W : MOBILE_W
  const frameScale = previewBoxW > 24 ? Math.min(1, (previewBoxW - 24) / frameW) : 1
  const FRAME_H = 560

  if (!open) return null
  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Description Themes"
      subtitle="Themes wrap each market's description body at push time — galleries, specs and policies fill in automatically."
      size="xl"
      footer={
        <>
          {error && <span className="mr-auto text-xs text-red-600 dark:text-red-400">{error}</span>}
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} loading={busy}>
            {isNew ? 'Create theme' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="flex gap-4 min-h-[480px]">
        {/* ── Theme list ── */}
        <div className="w-56 shrink-0 border-r border-slate-200 dark:border-slate-700 pr-3 flex flex-col gap-1">
          <Button size="sm" variant="secondary" className="justify-start" onClick={() => startNew()}>
            <Plus className="w-3.5 h-3.5 mr-1" /> New theme
          </Button>
          <div className="mt-1 flex-1 overflow-y-auto space-y-0.5">
            {themes.map((t) => {
              const assignedCount = usage?.byThemeId[t.id] ?? 0
              return (
              <button key={t.id} type="button"
                onClick={() => {
                  void (async () => {
                    if (dirty && selectedId !== t.id) {
                      const ok = await confirm({
                        title: 'Discard unsaved changes?',
                        description: `"${draft.name || 'New theme'}" has unsaved edits.`,
                        confirmLabel: 'Discard',
                        tone: 'warning',
                      })
                      if (!ok) return
                    }
                    selectTheme(t)
                  })()
                }}
                className={cn('w-full text-left px-2 py-1.5 rounded text-xs transition-colors',
                  selectedId === t.id
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300')}>
                <span className={cn('block truncate font-medium', !t.active && 'line-through opacity-60')}>{t.name}</span>
                <span className="flex flex-wrap gap-1 mt-0.5">
                  {t.isDefault && <span className="text-[9px] uppercase px-1 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Default</span>}
                  {t.builtIn && <span className="text-[9px] uppercase px-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">Built-in</span>}
                  {!t.active && <span className="text-[9px] uppercase px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Inactive</span>}
                  {t.notes?.includes('⚠') && <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" title={t.notes ?? undefined}>⚠ draft copy</span>}
                  {usage && (
                    <span className="text-[9px] px-1 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                      title="eBay listings explicitly assigned to this theme">
                      {assignedCount} listing{assignedCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {usage && t.isDefault && usage.default > 0 && (
                    <span className="text-[9px] px-1 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      title="Listings with no explicit pick — this default theme wraps them at push">
                      +{usage.default} default
                    </span>
                  )}
                </span>
              </button>
            )})}
            {themes.length === 0 && <p className="text-xs text-slate-400 px-2 py-4">Loading themes…</p>}
          </div>
          {usage && (
            <p className="mt-1 pt-1.5 border-t border-slate-200 dark:border-slate-700 text-[10px] leading-4 text-slate-400 px-1"
              title="Counts read from each eBay listing's per-market theme assignment">
              {usage.total} eBay listings · {usage.default} on default · {usage.raw} raw (no theme)
            </p>
          )}
        </div>

        {/* ── Editor + preview ── */}
        <div className="flex-1 min-w-0 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input type="text" value={draft.name} placeholder="Theme name…"
              onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); setDirty(true) }}
              className="flex-1 h-8 px-2 text-sm font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:outline-none focus:border-blue-400" />
            {selected && (
              <>
                <Button size="sm" variant="ghost" title="Duplicate into a new theme" onClick={() => startNew(selected)}>
                  <Copy className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant={selected.isDefault ? 'secondary' : 'ghost'}
                  title={selected.isDefault ? 'Unset as default' : 'Set as the default theme (wraps every listing without its own pick)'}
                  onClick={() => void setDefault(selected)} disabled={busy}>
                  <Star className={cn('w-3.5 h-3.5', selected.isDefault && 'fill-current text-amber-500')} />
                </Button>
                <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer" title="Inactive themes never render — listings fall back to the default">
                  <input type="checkbox" checked={draft.active}
                    onChange={(e) => { setDraft((d) => ({ ...d, active: e.target.checked })); setDirty(true) }}
                    className="w-3.5 h-3.5 accent-blue-600" />
                  Active
                </label>
                {!selected.builtIn && (
                  <Button size="sm" variant="ghost" title="Delete theme" onClick={() => void remove(selected)} disabled={busy}>
                    <Trash2 className="w-3.5 h-3.5 text-red-500" />
                  </Button>
                )}
              </>
            )}
          </div>
          <input type="text" value={draft.notes} placeholder="Notes (optional)…"
            onChange={(e) => { setDraft((d) => ({ ...d, notes: e.target.value })); setDirty(true) }}
            className="h-7 px-2 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 focus:outline-none focus:border-blue-400" />

          {/* ED v2 P3 — a ⚠ in the notes marks copy pending operator sign-off. */}
          {draft.notes.includes('⚠') && (
            <Banner tone="warning" title="Draft copy — operator sign-off required before assigning to live listings">
              {draft.notes}
            </Banner>
          )}

          {/* tabs */}
          <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700">
            {(['edit', 'preview'] as const).map((t) => (
              <button key={t} type="button"
                onClick={() => setTab(t)}
                className={cn('px-3 py-1.5 text-xs font-medium capitalize rounded-t transition-colors',
                  tab === t ? 'text-blue-700 dark:text-blue-300 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300')}>
                {t === 'preview' ? 'Preview (as pushed)' : 'Edit HTML'}
              </button>
            ))}
            {tab === 'preview' && (
              <span className="ml-auto mb-1 inline-flex items-center gap-1 text-[11px] text-slate-400">
                {previewBusy && <><Loader2 className="w-3 h-3 animate-spin" /> Rendering…</>}
              </span>
            )}
          </div>

          {tab === 'edit' ? (
            <>
              <div className="flex flex-wrap gap-1">
                {TOKENS.map((t) => (
                  <button key={t} type="button" onClick={() => insertToken(t)}
                    title="Insert at cursor"
                    className="px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-[10px] font-mono hover:bg-violet-100 dark:hover:bg-violet-900/40">
                    {t}
                  </button>
                ))}
              </div>
              <textarea ref={htmlRef} value={draft.html}
                onChange={(e) => { setDraft((d) => ({ ...d, html: e.target.value })); setDirty(true) }}
                spellCheck={false}
                className="flex-1 min-h-[300px] w-full rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 text-xs font-mono resize-none focus:outline-none focus:border-blue-400 dark:text-slate-100"
                placeholder="Theme HTML with {{tokens}}…" />
            </>
          ) : (
            <div className="flex-1 min-h-[380px] flex flex-col gap-2">
              {/* preview controls: product × market × width */}
              <div className="flex items-center gap-2">
                <PreviewProductPicker selected={previewProduct} onSelect={setPreviewProduct} />
                <Select value={previewMarket} onChange={(e) => setPreviewMarket(e.target.value)} aria-label="Preview market" title="Preview market">
                  {EBAY_MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
                <div className="flex rounded border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0" role="group" aria-label="Preview width">
                  <button type="button" onClick={() => setPreviewWidth('desktop')} title={`Desktop preview (${DESKTOP_W}px, scaled to fit)`}
                    className={cn('flex items-center gap-1 px-2 py-1.5 text-[11px] transition-colors',
                      previewWidth === 'desktop' ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800')}>
                    <Monitor className="w-3 h-3" /> Desktop
                  </button>
                  <button type="button" onClick={() => setPreviewWidth('mobile')} title={`Mobile preview (${MOBILE_W}px)`}
                    className={cn('flex items-center gap-1 px-2 py-1.5 text-[11px] border-l border-slate-200 dark:border-slate-700 transition-colors',
                      previewWidth === 'mobile' ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800')}>
                    <Smartphone className="w-3 h-3" /> Mobile
                  </button>
                </div>
                <button type="button" onClick={() => setRefreshTick((n) => n + 1)} disabled={previewBusy} title="Re-render now"
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                  <RefreshCw className={cn('w-3 h-3', previewBusy && 'animate-spin')} /> Refresh
                </button>
              </div>

              {!previewProduct && (
                <p className="text-xs text-amber-600 dark:text-amber-400">Pick a product above — previews render with a real product's images, specs and content.</p>
              )}
              {preview && preview.warnings.length > 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400" title={preview.warnings.join('\n')}>⚠ {preview.warnings.length} render warning{preview.warnings.length !== 1 ? 's' : ''}</p>
              )}

              <div ref={previewBoxRef} className="flex-1 min-h-[340px] overflow-auto rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-3">
                {srcDoc ? (
                  <div className="mx-auto overflow-hidden rounded shadow-sm" style={{ width: Math.round(frameW * frameScale), height: FRAME_H }}>
                    <div style={{ transform: `scale(${frameScale})`, transformOrigin: 'top left', width: frameW, height: FRAME_H / frameScale }}>
                      <iframe title="Description preview (as pushed)" sandbox="" srcDoc={srcDoc}
                        className="bg-white border-0" style={{ width: frameW, height: FRAME_H / frameScale }} />
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 px-2 py-6 text-center">
                    {previewBusy
                      ? 'Rendering exactly what a push would send…'
                      : !draft.html.trim()
                        ? 'Add theme HTML on the Edit tab first.'
                        : 'Nothing rendered yet — the preview updates automatically as you type.'}
                  </p>
                )}
              </div>
              {frameScale < 1 && srcDoc && (
                <p className="text-[10px] text-slate-400 text-center">Desktop frame is {frameW}px, scaled to {Math.round(frameScale * 100)}% to fit.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
