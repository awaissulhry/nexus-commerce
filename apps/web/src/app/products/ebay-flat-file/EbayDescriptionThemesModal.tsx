'use client'

/**
 * ED.4 — Description Theme manager. Two-pane modal on the eBay flat file:
 * theme list (starters + custom) on the left, editor + live "as pushed"
 * preview on the right. Previews render server-side via /description-preview
 * with the UNSAVED draft html (themeHtml override) against a real product
 * from the current grid, so what you see is exactly what a push would send.
 *
 * Built-in starters are editable but not deletable (the API enforces it);
 * the default theme wraps every listing that hasn't picked its own.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Plus, Copy, Star, Trash2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/design-system/components/Modal'
import { getBackendUrl } from '@/lib/backend-url'
import { useConfirm } from '@/components/ui/ConfirmProvider'

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

const TOKENS = [
  '{{title}}', '{{subtitle}}', '{{body}}', '{{sku}}', '{{brand}}', '{{market}}',
  '{{gallery}}', '{{gallery_shared}}', '{{specs_table}}', '{{policies}}',
]

export function EbayDescriptionThemesModal({ open, onClose, marketplace, sampleProductId, onChanged }: {
  open: boolean
  onClose: () => void
  marketplace: string
  /** A real product from the grid for live previews (first loaded family). */
  sampleProductId?: string
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
  const htmlRef = useRef<HTMLTextAreaElement>(null)

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

  useEffect(() => {
    if (open) { setError(null); setTab('edit'); setPreview(null); void load() }
  }, [open, load])

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

  const runPreview = async () => {
    if (!sampleProductId) return
    setPreviewBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/ebay/description-preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: sampleProductId, marketplace, mode: 'group', themeHtml: draft.html }),
      })
      const d = r.ok ? await r.json() : null
      setPreview(d ? { html: d.html, warnings: d.warnings ?? [] } : null)
    } catch { setPreview(null) } finally { setPreviewBusy(false) }
  }

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
            {themes.map((t) => (
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
                <span className="flex gap-1 mt-0.5">
                  {t.isDefault && <span className="text-[9px] uppercase px-1 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Default</span>}
                  {t.builtIn && <span className="text-[9px] uppercase px-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">Built-in</span>}
                  {!t.active && <span className="text-[9px] uppercase px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Inactive</span>}
                </span>
              </button>
            ))}
            {themes.length === 0 && <p className="text-xs text-slate-400 px-2 py-4">Loading themes…</p>}
          </div>
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

          {/* tabs */}
          <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700">
            {(['edit', 'preview'] as const).map((t) => (
              <button key={t} type="button"
                onClick={() => { setTab(t); if (t === 'preview') void runPreview() }}
                className={cn('px-3 py-1.5 text-xs font-medium capitalize rounded-t transition-colors',
                  tab === t ? 'text-blue-700 dark:text-blue-300 border-b-2 border-blue-500' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300')}>
                {t === 'preview' ? 'Preview (as pushed)' : 'Edit HTML'}
              </button>
            ))}
            {tab === 'preview' && (
              <button type="button" onClick={() => void runPreview()} disabled={previewBusy}
                className="ml-auto mb-1 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                <RefreshCw className={cn('w-3 h-3', previewBusy && 'animate-spin')} /> Refresh
              </button>
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
            <div className="flex-1 min-h-[300px] flex flex-col gap-1">
              {!sampleProductId && (
                <p className="text-xs text-amber-600 dark:text-amber-400">Load a family in the grid first — previews render with a real product's images, specs and content.</p>
              )}
              {preview && preview.warnings.length > 0 && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400" title={preview.warnings.join('\n')}>⚠ {preview.warnings.length} render warning{preview.warnings.length !== 1 ? 's' : ''}</p>
              )}
              <div className="flex-1 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 bg-white p-4">
                {previewBusy
                  ? <p className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Rendering exactly what a push would send…</p>
                  // Server-rendered from the operator's own draft + data, active-content-sanitized.
                  : <div dangerouslySetInnerHTML={{ __html: preview?.html || '<p style="color:#94a3b8;font-style:italic;">Nothing rendered yet — click Refresh.</p>' }} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
