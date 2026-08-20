'use client'

/**
 * DS-1 — Description Studio: the rebuilt eBay description-theme UI. One DS
 * Drawer (full height, min(1440px, 96vw)) replacing the tabbed modal with a
 * single always-visible surface:
 *
 *  - top context bar: ONE product chip set that is BOTH the preview seed and
 *    the push selection (star = currently previewing; cap mirrors the push
 *    route), ONE market select (preview & push), Desktop/Mobile width toggle;
 *  - 3-pane body: theme rail (240px) | editor | always-mounted live preview
 *    with the status strip (the truth surface) docked under it;
 *  - collapsible push dock at the bottom (draft-copy escalation, verbatim
 *    per-listing results — PushResults).
 *
 * Contracts (DS-1): every fetch resolves to {data}|{error} and BOTH arms
 * render; one refetchAll(scope) drives real-time consistency; dirty state is
 * confirmed before every destructive path; open-reset fires only on the
 * false→true open transition. Built complete but wired into no page — DS-2
 * swaps the entry point.
 *
 * DS-5: seedProducts auto-discovers the whole flat file's eligible families
 * into the chip set on open (capped at MAX_PUSH_PRODUCTS with an honest amber
 * note), and 'Reload families' re-syncs on demand — never dropping chips
 * without a confirm.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Copy, Loader2, Monitor, Plus, RefreshCw, Send, Smartphone, Star, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Drawer } from '@/design-system/components/Drawer'
import { Banner } from '@/design-system/components/Banner'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Button } from '@/design-system/primitives/Button'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Input } from '@/design-system/primitives/Input'
import { Pill } from '@/design-system/primitives/Pill'
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { Select } from '@/design-system/primitives/Select'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { Textarea } from '@/design-system/primitives/Textarea'
import { getBackendUrl } from '@/lib/backend-url'
import { EBAY_MARKETPLACES } from '../ebay-columns'
import { fetchJson } from './fetchJson'
import { ProductLookup } from './ProductLookup'
import { PushResults } from './PushResults'
import { StalenessPill } from './StalenessPill'
import { StatusStrip, type RenderStatus } from './StatusStrip'
import { useStudioConfirm } from './StudioConfirm'
import { noteIsFlagged, splitThemeNote, ThemeNote } from './ThemeNote'
import { THEME_TOKEN_INFO, THEME_TOKENS } from './tokens'
import {
  MAX_PUSH_PRODUCTS,
  type PreviewProduct,
  type PreviewResponse,
  type PushResult,
  type StalenessEntry,
  type Theme,
  type ThemeUsage,
} from './types'

const DESKTOP_W = 920
const MOBILE_W = 375

export interface EbayDescriptionStudioProps {
  open: boolean
  onClose: () => void
  marketplace: string
  /** DS-5 — auto-discovered families from the open flat file (grid row order,
   *  deduped by product id, isDescSyncEligible-gated by the caller). Seeds the
   *  whole chip set on open, capped at MAX_PUSH_PRODUCTS with an HONEST amber
   *  note — never silent truncation. */
  seedProducts?: Array<{ productId: string; sku: string }>
  /** A real product from the grid seeding the STAR within seedProducts (and
   *  the lone fallback chip when seedProducts is absent/empty). */
  sampleProductId?: string
  /** SKU label for that product, shown on the chip until the operator changes it. */
  sampleProductSku?: string
  /** Called after any create/update/delete/default change so the page can refresh its theme list. */
  onChanged?: () => void
  /** DS-1 — called after a push completes (DS-2 wires grid refreshes to it). */
  onPushed?: () => void
}

export function EbayDescriptionStudio({ open, onClose, marketplace, seedProducts, sampleProductId, sampleProductSku, onChanged, onPushed }: EbayDescriptionStudioProps) {
  // DS-6 — every confirmation renders INSIDE this drawer (see StudioConfirm):
  // the app-wide confirm portals a z-50 Modal, which the z-61 drawer panel
  // covered, so discard / delete / reload / push gates were all invisible.
  const { confirm, overlay: confirmOverlay, isOpen: confirmOpen, cancel: cancelConfirm } = useStudioConfirm()

  // ── theme rail ──
  const [themes, setThemes] = useState<Theme[] | null>(null) // null = loading
  const [themesError, setThemesError] = useState<string | null>(null)
  // ── editor ──
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ name: string; notes: string; html: string; active: boolean }>({ name: '', notes: '', html: '', active: true })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ currentVersion: number | null } | null>(null)
  // ── unified product chip set (preview AND push selection) ──
  const [products, setProducts] = useState<PreviewProduct[]>([])
  const [starredId, setStarredId] = useState<string | null>(null)
  const [addFeedback, setAddFeedback] = useState<{ text: string; tone: 'info' | 'warn' } | null>(null)
  /** DS-5 — persistent honest-truncation note when seedProducts exceeds the cap. */
  const [seedCapNote, setSeedCapNote] = useState<string | null>(null)
  // ── market + preview width ──
  const [market, setMarket] = useState('IT')
  const [previewWidth, setPreviewWidth] = useState<'desktop' | 'mobile'>('desktop')
  // ── usage / staleness ──
  const [usage, setUsage] = useState<ThemeUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [usageTick, setUsageTick] = useState(0)
  const [staleness, setStaleness] = useState<Record<string, StalenessEntry>>({})
  const [stalenessError, setStalenessError] = useState<string | null>(null)
  const [stalenessTick, setStalenessTick] = useState(0)
  // ── preview ──
  const [render, setRender] = useState<RenderStatus>({ phase: 'idle', warnings: [] })
  const [refreshTick, setRefreshTick] = useState(0)
  // ── push dock ──
  const [dockOpen, setDockOpen] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [pushError, setPushError] = useState<string | null>(null)
  const [pushResult, setPushResult] = useState<{ res: PushResult; themeName: string; at: string } | null>(null)

  const editorBoxRef = useRef<HTMLDivElement>(null)
  const previewBoxRef = useRef<HTMLDivElement>(null)
  const pushOutcomeRef = useRef<HTMLDivElement>(null)
  const [previewBox, setPreviewBox] = useState({ w: 0, h: 0 })

  const selected = useMemo(() => themes?.find((t) => t.id === selectedId) ?? null, [themes, selectedId])
  const isNew = selectedId === null
  const previewProduct = useMemo(() => products.find((p) => p.id === starredId) ?? null, [products, starredId])
  const draftHtml = draft.html

  // Refs mirror selection/dirty so background refetches (focus, mutations)
  // never read stale closures when deciding whether to touch the editor.
  const selectedIdRef = useRef(selectedId)
  const dirtyRef = useRef(dirty)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  // ── loaders — every arm renders somewhere (DS-1 contract) ──────────────────

  const applyThemeToEditor = (t: Theme) => {
    setDraft({ name: t.name, notes: t.notes ?? '', html: t.html, active: t.active })
    setDirty(false)
    setConflict(null)
  }

  const loadThemes = useCallback(async (keepSelection: boolean) => {
    const r = await fetchJson<{ themes: Theme[] }>(`${getBackendUrl()}/api/ebay/description-themes`)
    if (!r.ok) { if (!r.aborted) setThemesError(r.error); return }
    setThemesError(null)
    const list = r.data.themes
    setThemes(list)
    if (keepSelection) {
      const curId = selectedIdRef.current
      if (curId === null) {
        // A NEW-theme draft owns the editor — never steal it. (After a delete
        // the refs are cleared first, so the reselect below still runs.)
        if (dirtyRef.current) return
      } else {
        const cur = list.find((t) => t.id === curId)
        if (cur) {
          // Refresh the editor from the server copy ONLY when clean — a dirty
          // draft is never clobbered by a background refetch (409 owns that).
          if (!dirtyRef.current) applyThemeToEditor(cur)
          return
        }
        // fall through: the selected theme vanished (deleted elsewhere)
      }
    }
    const first = list.find((t) => t.isDefault) ?? list[0]
    if (first) {
      setSelectedId(first.id)
      selectedIdRef.current = first.id
      applyThemeToEditor(first)
    } else {
      setSelectedId(null)
    }
  }, [])

  // Usage — market-scoped, root-counted (DS-0). Failure = 'usage unavailable' chip.
  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    void (async () => {
      const r = await fetchJson<ThemeUsage>(
        `${getBackendUrl()}/api/ebay/description-themes/usage?marketplace=${encodeURIComponent(market)}`,
        { signal: ctrl.signal },
      )
      if (!r.ok) { if (!r.aborted) { setUsage(null); setUsageError(r.error) } return }
      setUsageError(null)
      setUsage(r.data)
    })()
    return () => ctrl.abort()
  }, [open, market, usageTick])

  // Staleness — the whole chip set at once. Failure = gray "unknown" pill.
  useEffect(() => {
    if (!open) return
    const ids = [...new Set(products.map((p) => p.id))]
    if (ids.length === 0) { setStaleness({}); setStalenessError(null); return }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      void (async () => {
        const r = await fetchJson<{ products: StalenessEntry[] }>(
          `${getBackendUrl()}/api/ebay/description-themes/staleness?productIds=${encodeURIComponent(ids.join(','))}&marketplace=${encodeURIComponent(market)}`,
          { signal: ctrl.signal },
        )
        if (!r.ok) { if (!r.aborted) setStalenessError(r.error); return }
        setStalenessError(null)
        const next: Record<string, StalenessEntry> = {}
        for (const p of r.data.products) next[p.productId] = p
        setStaleness(next)
      })()
    }, 300)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [open, products, market, stalenessTick])

  // ── ONE real-time funnel: what changed decides what refreshes ──────────────
  //  mutation (save/delete/setDefault/push) → themes + usage + staleness + preview
  //  selection (chips/star/market)          → staleness (+ preview via its deps)
  //  typing                                 → preview only (draftHtml dep)
  //  window focus / visibility              → usage + staleness
  const refetchAll = useCallback((scope: 'mutation' | 'selection' | 'focus') => {
    if (scope === 'mutation') {
      void loadThemes(true)
      setUsageTick((n) => n + 1)
      setStalenessTick((n) => n + 1)
      setRefreshTick((n) => n + 1)
    } else if (scope === 'selection') {
      setStalenessTick((n) => n + 1)
      // preview follows via its own deps (previewProduct / market)
    } else {
      setUsageTick((n) => n + 1)
      setStalenessTick((n) => n + 1)
    }
  }, [loadThemes])

  useEffect(() => {
    if (!open) return
    const onFocus = () => refetchAll('focus')
    const onVis = () => { if (document.visibilityState === 'visible') refetchAll('focus') }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [open, refetchAll])

  // ── DS-5 — seed derivation: auto-discovered families → chips ───────────────
  // Dedupes defensively (the caller already dedupes), caps at the push limit
  // and reports the TRUE total so truncation is always announced. Falls back
  // to the single sampleProductId chip when no seedProducts arrive (old
  // callers / an empty sheet).
  const deriveSeed = useCallback((): { chips: PreviewProduct[]; total: number } => {
    const seen = new Set<string>()
    const all: PreviewProduct[] = []
    for (const p of seedProducts ?? []) {
      if (!p.productId || seen.has(p.productId)) continue
      seen.add(p.productId)
      all.push({ id: p.productId, sku: p.sku })
    }
    if (all.length === 0 && sampleProductId) {
      all.push({ id: sampleProductId, sku: sampleProductSku ?? 'Current grid family' })
    }
    return { chips: all.slice(0, MAX_PUSH_PRODUCTS), total: all.length }
  }, [seedProducts, sampleProductId, sampleProductSku])

  /** Current seed snapshot — 'Reload families (N)' shows the TRUE family count. */
  const seedInfo = useMemo(() => deriveSeed(), [deriveSeed])

  const capNoteFor = (total: number): string | null =>
    total > MAX_PUSH_PRODUCTS
      ? `Showing the first ${MAX_PUSH_PRODUCTS} of ${total} families — remove some or add specific ones via search`
      : null

  // Star seed: the grid's sampleProductId if it made the chip set, else chip #1.
  const starFor = (chips: PreviewProduct[], preferred?: string | null): string | null =>
    preferred && chips.some((p) => p.id === preferred)
      ? preferred
      : sampleProductId && chips.some((p) => p.id === sampleProductId)
        ? sampleProductId
        : chips[0]?.id ?? null

  // ── open-reset — keyed ONLY on the false→true transition ───────────────────
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setActionError(null); setConflict(null)
      setMarket(EBAY_MARKETPLACES.includes(marketplace) ? marketplace : 'IT')
      // DS-5 — the WHOLE flat file's eligible families seed the chip set.
      const { chips, total } = deriveSeed()
      setProducts(chips)
      setStarredId(starFor(chips))
      setSeedCapNote(capNoteFor(total))
      setAddFeedback(null)
      setDockOpen(false); setPushResult(null); setPushError(null)
      setRender({ phase: 'idle', warnings: [] })
      setThemes(null); setThemesError(null)
      setUsage(null); setUsageError(null)
      setStaleness({}); setStalenessError(null)
      setSelectedId(null); selectedIdRef.current = null
      setDirty(false); dirtyRef.current = false
      void loadThemes(false)
    }
    wasOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, marketplace, deriveSeed, loadThemes])

  // ── DS-5 — 'Reload families' re-syncs chips from seedProducts (same cap
  // rule). Chips the reload would drop — manually-added ones, or seeded ones
  // beyond the cap — are NEVER wiped silently: a confirm lists them first. ────
  const reloadFamilies = useCallback(async () => {
    const { chips, total } = deriveSeed()
    const nextIds = new Set(chips.map((c) => c.id))
    const dropped = products.filter((p) => !nextIds.has(p.id))
    if (dropped.length > 0) {
      const shown = dropped.slice(0, 6).map((p) => p.sku).join(', ')
        + (dropped.length > 6 ? ` … and ${dropped.length - 6} more` : '')
      const ok = await confirm({
        title: 'Reload families from the flat file?',
        body: `Re-syncing replaces the chip set with the sheet's ${Math.min(total, MAX_PUSH_PRODUCTS)} eligible famil${Math.min(total, MAX_PUSH_PRODUCTS) === 1 ? 'y' : 'ies'} and removes ${dropped.length} chip${dropped.length === 1 ? '' : 's'} not in that set (manually added, or beyond the ${MAX_PUSH_PRODUCTS}-family cap): ${shown}.`,
        confirmLabel: 'Reload & replace',
        tone: 'warning',
        testId: 'studio-confirm-reload',
      })
      if (!ok) return
    }
    setProducts(chips)
    setStarredId((cur) => starFor(chips, cur))
    setSeedCapNote(capNoteFor(total))
    setAddFeedback(null)
    refetchAll('selection')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deriveSeed, products, confirm, sampleProductId, refetchAll])

  // ── dirty guard — confirmed before EVERY destructive path ──────────────────
  const guardDirty = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true
    return confirm({
      title: 'Discard unsaved changes?',
      body: `"${draft.name || 'New theme'}" has unsaved edits. Discarding throws away the editor's HTML, name, notes and Active flag — the saved version stays exactly as it is.`,
      confirmLabel: 'Discard edits',
      cancelLabel: 'Keep editing',
      tone: 'warning',
      testId: 'studio-confirm-discard',
    })
  }, [dirty, draft.name, confirm])

  // Esc, backdrop and the drawer's × all land here (Drawer calls onClose).
  const requestClose = useCallback(() => {
    // A pending in-drawer confirmation owns the panel: Esc/backdrop cancels
    // THAT, never the whole Studio out from under it.
    if (confirmOpen) { cancelConfirm(); return }
    if (busy || pushBusy) return
    void (async () => {
      if (await guardDirty()) onClose()
    })()
  }, [confirmOpen, cancelConfirm, busy, pushBusy, guardDirty, onClose])

  const selectTheme = async (t: Theme) => {
    if (t.id === selectedId) return
    if (!(await guardDirty())) return
    setSelectedId(t.id)
    applyThemeToEditor(t)
    setActionError(null)
  }

  const startNew = async (from?: Theme) => {
    if (!(await guardDirty())) return
    setSelectedId(null)
    setDraft({
      name: from ? `${from.name} copy` : '',
      notes: from?.notes ?? '',
      html: from?.html ?? '<div style="font-family:Arial,sans-serif;">\n  <h1>{{title}}</h1>\n  {{body}}\n  {{gallery}}\n  {{specs_table}}\n  {{policies}}\n</div>',
      active: true,
    })
    setDirty(true)
    setConflict(null)
    setActionError(null)
  }

  // ── mutations — every error renders as a Banner near the action ────────────

  const save = useCallback(async () => {
    if (busy) return
    if (!draft.name.trim() || !draft.html.trim()) { setActionError('Name and HTML are required'); return }
    setBusy(true); setActionError(null); setConflict(null)
    const r = isNew
      ? await fetchJson<{ theme: Theme }>(`${getBackendUrl()}/api/ebay/description-themes`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: draft.name, html: draft.html, notes: draft.notes || undefined }),
        })
      : await fetchJson<{ theme: Theme }>(`${getBackendUrl()}/api/ebay/description-themes/${selectedId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          // DS-0 optimistic concurrency: a stale editor loses LOUDLY (409).
          body: JSON.stringify({ name: draft.name, html: draft.html, notes: draft.notes, active: draft.active, expectedVersion: selected?.version }),
        })
    setBusy(false)
    if (!r.ok) {
      if (r.aborted) return
      if (r.status === 409 && !isNew) {
        const cv = (r.body as { currentVersion?: number } | null)?.currentVersion
        setConflict({ currentVersion: typeof cv === 'number' ? cv : null })
      } else {
        setActionError(`Save failed: ${r.error}`)
      }
      return
    }
    if (r.data.theme?.id) { setSelectedId(r.data.theme.id); selectedIdRef.current = r.data.theme.id }
    setDirty(false); dirtyRef.current = false
    refetchAll('mutation')
    onChanged?.()
  }, [busy, draft, isNew, selectedId, selected?.version, refetchAll, onChanged])

  // The 409 Banner's action: replace the draft with the other session's saved
  // version (the label says it discards the local draft — that IS the action).
  const reloadTheme = useCallback(async () => {
    const r = await fetchJson<{ themes: Theme[] }>(`${getBackendUrl()}/api/ebay/description-themes`)
    if (!r.ok) { setActionError(`Reload failed: ${r.error}`); return }
    setThemesError(null)
    setThemes(r.data.themes)
    const fresh = r.data.themes.find((t) => t.id === selectedIdRef.current)
    if (fresh) applyThemeToEditor(fresh)
    else setActionError('Reload found no such theme any more — it was deleted elsewhere.')
    setConflict(null)
  }, [])

  const setDefault = async (t: Theme) => {
    setBusy(true); setActionError(null)
    const r = await fetchJson<{ ok: boolean }>(`${getBackendUrl()}/api/ebay/description-themes/${t.isDefault ? 'none' : t.id}/default`, { method: 'POST' })
    setBusy(false)
    if (!r.ok) { setActionError(`Set-default failed: ${r.error}`); return }
    refetchAll('mutation')
    onChanged?.()
  }

  const remove = async (t: Theme) => {
    const assigned = usage?.byThemeId[t.id] ?? 0
    const ok = await confirm({
      title: `Delete theme "${t.name}"?`,
      body: (
        <div className="flex flex-col gap-2">
          <p>
            Listings assigned to it fall back to the default theme at their next push. Live descriptions
            already on eBay are NOT changed by this — they keep the HTML that was pushed until something
            re-pushes them.
          </p>
          {assigned > 0 && (
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              {assigned} {market} listing famil{assigned === 1 ? 'y is' : 'ies are'} currently assigned to this theme.
            </p>
          )}
          <p className="font-semibold">This cannot be undone.</p>
        </div>
      ),
      confirmLabel: 'Delete theme',
      tone: 'danger',
      testId: 'studio-confirm-delete',
    })
    if (!ok) return
    setBusy(true); setActionError(null)
    const r = await fetchJson<{ ok: boolean }>(`${getBackendUrl()}/api/ebay/description-themes/${t.id}`, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setActionError(`Delete failed: ${r.error}`); return }
    // Clear the refs BEFORE the refetch so loadThemes reselects the default.
    setSelectedId(null); selectedIdRef.current = null
    setDirty(false); dirtyRef.current = false
    refetchAll('mutation')
    onChanged?.()
  }

  // ── Cmd/Ctrl+S saves (while open) ──────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        // A pending confirmation owns the panel — never save behind it.
        if (dirty && !busy && !pushBusy && !confirmOpen) void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dirty, busy, pushBusy, confirmOpen, save])

  // ── unified chip set — add / remove / star (never a silent no-op) ──────────
  const addProduct = useCallback((p: PreviewProduct) => {
    if (products.some((x) => x.id === p.id)) {
      setAddFeedback({ text: `${p.sku} is already in the set.`, tone: 'info' })
      return
    }
    if (products.length >= MAX_PUSH_PRODUCTS) {
      setAddFeedback({ text: `Cap reached — max ${MAX_PUSH_PRODUCTS} products per push (the server refuses more). Remove one first.`, tone: 'warn' })
      return
    }
    setProducts([...products, p])
    if (starredId === null) setStarredId(p.id)
    setAddFeedback({ text: `Added ${p.sku} — previewed and pushed with the set.`, tone: 'info' })
    refetchAll('selection')
  }, [products, starredId, refetchAll])

  const removeProduct = (id: string) => {
    const remaining = products.filter((p) => p.id !== id)
    setProducts(remaining)
    if (starredId === id) setStarredId(remaining[0]?.id ?? null)
    setAddFeedback(null)
    refetchAll('selection')
  }

  const starProduct = (id: string) => {
    if (id === starredId) return
    setStarredId(id)
    refetchAll('selection')
  }

  const skuById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const p of products) map[p.id] = p.sku
    return map
  }, [products])

  // ── live preview — debounced render, aborting stale requests. Gated ONLY on
  // [open, previewProduct, market, draftHtml, refreshTick] — NO tab gate; the
  // pane is always mounted. A failure keeps the last GOOD frame (dimmed). ────
  useEffect(() => {
    if (!open) return
    if (!previewProduct?.id || !draftHtml.trim()) {
      setRender({ phase: 'idle', warnings: [] })
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      setRender((prev) => ({ ...prev, phase: 'rendering' }))
      const r = await fetchJson<PreviewResponse>(`${getBackendUrl()}/api/ebay/description-preview`, {
        // `mode` is deliberately NOT sent: the endpoint derives it from the
        // family exactly as the push service does (children → 'group', else
        // 'single'). Hardcoding 'group' made the preview of a standalone
        // product render gallery sections the push would never send.
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: previewProduct.id, marketplace: market, themeHtml: draftHtml }),
        signal: ctrl.signal,
      })
      if (!r.ok) {
        if (r.aborted) return
        // Keep prev.html — the stale frame stays visible but DIMMED, never blank.
        setRender((prev) => ({ ...prev, phase: 'failed', errorStatus: r.status, errorBody: r.error }))
        return
      }
      setRender({
        phase: 'ok',
        html: r.data.html,
        renderedAt: new Date().toLocaleTimeString(),
        themed: r.data.themed,
        themeName: r.data.themeName,
        themeVersion: r.data.themeVersion,
        warnings: r.data.warnings ?? [],
      })
    }, 500)
    return () => { clearTimeout(t); ctrl.abort() }
  }, [open, previewProduct, market, draftHtml, refreshTick])

  // Measure the preview pane so the 920px desktop frame scales to fit (same
  // math as the modal, no tab gate — the pane exists whenever the drawer does).
  useEffect(() => {
    if (!open) return
    const el = previewBoxRef.current
    if (!el) return
    const measure = () => setPreviewBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open])

  // Sandboxed document: sandbox="" blocks scripts/navigation and the srcDoc
  // wrapper keeps theme CSS inside the frame instead of leaking into the app.
  const srcDoc = useMemo(() => {
    if (!render.html) return ''
    return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><style>html,body{margin:0;padding:0;background:#ffffff;}body{padding:12px;font-family:Arial,Helvetica,sans-serif;color:#111827;}img{max-width:100%;}</style></head><body>${render.html}</body></html>`
  }, [render.html])

  /** Where the caret must land once React has committed an inserted token. */
  const pendingCaretRef = useRef<number | null>(null)

  // The caret is restored in an EFFECT, not a rAF: the textarea is controlled,
  // so React re-assigns `.value` on commit and that moves the caret. A rAF can
  // fire before that commit, in which case the restore is overwritten and the
  // next insert reads a caret of 0 — tokens then pile up at the start of the
  // theme instead of landing where the operator clicked.
  useEffect(() => {
    const pos = pendingCaretRef.current
    if (pos == null) return
    pendingCaretRef.current = null
    const el = editorBoxRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-role="theme-html"]')
    if (!el) return
    el.focus()
    el.selectionStart = el.selectionEnd = pos
  }, [draft.html])

  const insertToken = (token: string) => {
    // DS Textarea doesn't forward refs (React 18) — reach the element through
    // the wrapper so insert-at-cursor keeps working on the DS primitive. The
    // [data-role] is required: the notes field is a <textarea> too, and the
    // bare tag selector would target THAT one.
    const el = editorBoxRef.current?.querySelector<HTMLTextAreaElement>('textarea[data-role="theme-html"]')
    if (!el) return
    const start = el.selectionStart ?? draft.html.length
    const end = el.selectionEnd ?? start
    pendingCaretRef.current = start + token.length
    setDraft((d) => ({ ...d, html: d.html.slice(0, start) + token + d.html.slice(end) }))
    setDirty(true)
  }

  const frameW = previewWidth === 'desktop' ? DESKTOP_W : MOBILE_W
  const frameScale = previewBox.w > 24 ? Math.min(1, (previewBox.w - 24) / frameW) : 1
  const frameH = Math.max(360, previewBox.h - 24)

  // ── push — the SAVED theme only, danger-gated (verbatim from the modal) ────
  const pushDraftCopy = noteIsFlagged(selected?.notes)
  const pushBlockReason = isNew
    ? 'Save the theme first — the push sends a SAVED theme, and this new theme has no saved version yet.'
    : dirty
      ? `Unsaved edits — the push would send the last SAVED version of "${selected?.name ?? draft.name}", not what the editor shows. Save (or discard) your edits first.`
      : selected && !selected.active
        ? 'This theme is inactive — inactive themes never render. Activate and save it before pushing.'
        : products.length === 0
          ? 'Add at least one product to enable the push.'
          : null

  /** Staleness across the whole chip set — drives the dock pill AND the
   *  "already in sync" line in the confirmation. */
  const staleSummary = useMemo(() => {
    const entries = products.map((p) => staleness[p.id]).filter((e): e is StalenessEntry => !!e)
    return { total: entries.length, stale: entries.filter((e) => e.stale).length }
  }, [products, staleness])

  const runPush = async () => {
    if (!selected || dirty || products.length === 0 || pushBusy) return
    // The confirmation lives INSIDE the drawer (DS-6) and scrolls, so the full
    // family list is shown — no "… and N more" the operator can't inspect.
    const ok = await confirm({
      title: `Revise LIVE eBay descriptions on ${market}?`,
      tone: 'danger',
      testId: 'studio-confirm-push',
      confirmLabel: pushDraftCopy
        ? `Push DRAFT copy to ${market} live listings`
        : `Revise ${market} live descriptions`,
      cancelLabel: 'Cancel — send nothing',
      acknowledge: pushDraftCopy
        ? 'I have read the draft-copy warning and accept putting this text on live listings'
        : undefined,
      body: (
        <div className="flex flex-col gap-2.5">
          <p>
            This revises the description of <span className="font-semibold">EVERY live eBay listing</span> (primary
            + adopted shared listings) of these {products.length} product famil
            {products.length === 1 ? 'y' : 'ies'} on {market}:
          </p>
          <div className="max-h-40 overflow-y-auto rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1.5 flex flex-wrap gap-1">
            {products.map((p) => (
              <span key={p.id}
                className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 text-[11px] font-medium">
                {p.sku}
                {p.hasEbayListing === false && (
                  <span className="text-[9px] uppercase text-amber-700 dark:text-amber-400"
                    title="No eBay listing yet — the push reports this honestly, it cannot create one">
                    no listing
                  </span>
                )}
              </span>
            ))}
          </div>
          <p>
            Theme <span className="font-semibold">"{selected.name}"</span> (v{selected.version}) is assigned to each
            family and wraps each listing's own body copy. Only the description changes —{' '}
            <span className="font-semibold">price, quantity, title and variations are untouched</span>. Each revise
            is read back from eBay (parity check) and reported per listing below.
          </p>
          {staleSummary.total > 0 && staleSummary.stale === 0 && (
            <p className="text-slate-500 dark:text-slate-400">
              All {staleSummary.total} checked famil{staleSummary.total === 1 ? 'y is' : 'ies are'} already in sync
              with the last push — re-pushing is safe but may be unnecessary.
            </p>
          )}
          {pushDraftCopy && (
            <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-2 text-amber-900 dark:text-amber-200">
              <p className="text-[12px] font-bold mb-1">⚠ DRAFT COPY — not signed off</p>
              <ThemeNote notes={selected.notes} />
            </div>
          )}
        </div>
      ),
    })
    if (!ok) return
    setPushBusy(true)
    setPushError(null)
    setPushResult(null)
    const r = await fetchJson<PushResult>(`${getBackendUrl()}/api/ebay/description-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productIds: products.map((p) => p.id), marketplace: market, themeId: selected.id }),
    })
    setPushBusy(false)
    if (!r.ok || !Array.isArray(r.data?.listings)) {
      setPushError(r.ok ? 'Push returned an unexpected payload (no listings array)' : r.error)
      return
    }
    // DS-4 — full date + time: push results persist until the drawer closes,
    // so a bare time ("14:03") loses its meaning across day boundaries.
    setPushResult({ res: r.data, themeName: selected.name, at: new Date().toLocaleString() })
    refetchAll('mutation') // theme assignments + staleness stamps changed server-side
    onChanged?.()
    onPushed?.()
  }

  // A finished push reports per ItemID inside a scrolling dock — bring the
  // outcome into view so nobody reads "Pushing…" turning back into a button
  // and assumes silence meant success.
  useEffect(() => {
    if (!pushResult && !pushError) return
    const t = setTimeout(() => pushOutcomeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60)
    return () => clearTimeout(t)
  }, [pushResult, pushError])

  // Collapsed-dock aggregate pill: last push outcome wins; else selection staleness.
  const dockPill = useMemo(() => {
    if (pushResult) {
      const ls = pushResult.res.listings
      const failed = ls.filter((l) => l.outcome === 'failed').length
      const parity = ls.filter((l) => l.warnings.some((w) => w.includes('PARITY MISMATCH'))).length
      const prodErr = pushResult.res.products.filter((p) => p.error).length
      if (failed + parity + prodErr > 0) return { tone: 'danger' as const, label: `last push: ${failed} failed · ${parity} parity · ${prodErr} product errors` }
      // A listing handed off to Full Publish, or skipped for an empty body, is
      // NOT "clean" — it still needs the operator. Saying "clean" here while
      // the body says "1 needs a Full Publish" is the exact kind of glance-lie
      // this dock exists to prevent.
      const revised = ls.filter((l) => l.outcome === 'revised').length
      const needsFullPublish = ls.filter((l) => l.outcome === 'inventory-managed').length
      const emptyBody = ls.filter((l) => l.outcome === 'skipped-empty-body').length
      if (needsFullPublish + emptyBody > 0) {
        return {
          tone: 'warning' as const,
          label: `last push: ${revised} revised`
            + (needsFullPublish > 0 ? ` · ${needsFullPublish} need${needsFullPublish === 1 ? 's' : ''} Full Publish` : '')
            + (emptyBody > 0 ? ` · ${emptyBody} skipped (empty body)` : ''),
        }
      }
      return { tone: 'success' as const, label: `last push clean — ${ls.length} listing${ls.length === 1 ? '' : 's'}` }
    }
    if (products.length === 0) return null
    if (stalenessError) return { tone: 'neutral' as const, label: 'staleness unknown' }
    if (staleSummary.total === 0) return null
    return staleSummary.stale > 0
      ? { tone: 'warning' as const, label: `${staleSummary.stale}/${staleSummary.total} stale` }
      : { tone: 'success' as const, label: 'in sync' }
  }, [pushResult, products.length, staleSummary, stalenessError])

  if (!open) return null
  return (
    <Drawer
      open
      onClose={requestClose}
      title="Description Studio"
      subtitle="Themes wrap each market's description body at push time — galleries, specs and policies fill in automatically."
      width="min(1440px, 96vw)"
      // DS-6 — confirmations render inside the panel instead of behind it.
      overlay={confirmOverlay}
      footer={
        <>
          <span className="mr-auto text-[10.5px] text-slate-400">
            {pushBusy ? 'Pushing to eBay — the Studio stays open until every listing has reported.' : '⌘S / Ctrl+S saves'}
          </span>
          <Button size="sm" variant="ghost" onClick={requestClose} disabled={busy || pushBusy || confirmOpen}>Close</Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || pushBusy || confirmOpen || !dirty}>
            {busy
              ? <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>
              : isNew ? 'Create theme' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="h-full min-h-0 flex flex-col gap-3">
        {/* ── top context bar: ONE chip set = preview AND push selection ── */}
        <div className="shrink-0 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[280px] flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <ProductLookup onSelect={addProduct} disabled={pushBusy}
                placeholder="Add a product — search by SKU or title…" />
              <span className="shrink-0 text-[10px] text-slate-400" title={`Server cap: ${MAX_PUSH_PRODUCTS} products per push`}>
                {products.length}/{MAX_PUSH_PRODUCTS}
              </span>
              {(seedProducts?.length ?? 0) > 0 && (
                <button type="button" onClick={() => void reloadFamilies()} disabled={pushBusy}
                  title="Re-sync the chip set with the flat file's current eligible families (asks first if any chip would be removed)"
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                  <RefreshCw className="w-3 h-3" /> Reload families ({seedInfo.total})
                </button>
              )}
            </div>
            {products.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                {products.map((p) => {
                  const starred = p.id === starredId
                  const st = staleness[p.id]
                  return (
                    <span key={p.id}
                      className={cn('inline-flex items-center gap-1 rounded border pl-1 pr-1 py-0.5 text-xs',
                        starred
                          ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-slate-800 dark:text-slate-100'
                          : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200')}>
                      <button type="button" onClick={() => starProduct(p.id)}
                        title={starred ? `Previewing ${p.sku}` : `Preview ${p.sku} instead (moves the star)`}
                        className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40">
                        <Star className={cn('w-3 h-3', starred ? 'fill-current text-amber-500' : 'text-slate-400')} />
                      </button>
                      {stalenessError ? (
                        <span title={`Staleness unknown — check failed: ${stalenessError}`}
                          className="w-1.5 h-1.5 rounded-full shrink-0 bg-slate-400" />
                      ) : st ? (
                        <span
                          title={st.stale ? `Stale: ${st.reasons.join(' · ')}` : 'In sync with the last description push'}
                          className={cn('w-1.5 h-1.5 rounded-full shrink-0', st.stale ? 'bg-amber-400' : 'bg-emerald-400')}
                        />
                      ) : null}
                      <span className="font-semibold">{p.sku}</span>
                      {p.hasEbayListing === false && (
                        <span className="text-[9px] uppercase px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                          title="No eBay listing yet — the push will report this honestly, it cannot create one">
                          no listing
                        </span>
                      )}
                      <button type="button" onClick={() => removeProduct(p.id)} disabled={pushBusy}
                        title={`Remove ${p.sku} from preview AND push`}
                        className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No products selected — search above. The ★ chip drives the preview; ALL chips are pushed.
              </p>
            )}
            {/* DS-5 — honest truncation: the cap note persists (no silent cut). */}
            {seedCapNote && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">{seedCapNote}</p>
            )}
            {addFeedback && (
              <p className={cn('text-[11px]', addFeedback.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400')}>
                {addFeedback.text}
              </p>
            )}
          </div>
          <label className="shrink-0 flex flex-col gap-1 text-[10.5px] font-medium text-slate-500 dark:text-slate-400">
            Market — preview &amp; push
            <Select value={market} onChange={(e) => { setMarket(e.target.value); refetchAll('selection') }}
              aria-label="Market — preview & push">
              {EBAY_MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </label>
          <label className="shrink-0 flex flex-col gap-1 text-[10.5px] font-medium text-slate-500 dark:text-slate-400">
            Preview width
            <SegmentedControl size="sm" value={previewWidth} onChange={(v) => setPreviewWidth(v as 'desktop' | 'mobile')}
              options={[
                { value: 'desktop', label: `Desktop ${DESKTOP_W}px`, icon: <Monitor size={13} /> },
                { value: 'mobile', label: `Mobile ${MOBILE_W}px`, icon: <Smartphone size={13} /> },
              ]} />
          </label>
        </div>

        {/* ── 3-pane body ── */}
        <div className="flex-1 min-h-0 flex gap-3">
          {/* LEFT — theme rail (240px) */}
          <div className="w-[240px] shrink-0 border-r border-slate-200 dark:border-slate-700 pr-3 flex flex-col gap-1 min-h-0">
            <Button size="sm" onClick={() => void startNew()} className="justify-start">
              <Plus className="w-3.5 h-3.5" /> New theme
            </Button>
            <div className="mt-1 flex-1 min-h-0 overflow-y-auto space-y-0.5">
              {themesError ? (
                <Banner tone="danger" title="Themes failed to load"
                  action={<Button size="sm" onClick={() => { setThemesError(null); setThemes(null); void loadThemes(true) }}>Retry</Button>}>
                  {themesError}
                </Banner>
              ) : themes === null ? (
                <div className="flex flex-col gap-2 px-1 py-2" aria-label="Loading themes">
                  {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={34} radius={6} />)}
                </div>
              ) : themes.length === 0 ? (
                <EmptyState title="No themes yet" description="Create one — the built-in starters seed on the next load." />
              ) : (
                themes.map((t) => {
                  const assignedCount = usage?.byThemeId[t.id] ?? 0
                  return (
                    <button key={t.id} type="button"
                      onClick={() => void selectTheme(t)}
                      className={cn('w-full text-left px-2 py-1.5 rounded text-xs transition-colors',
                        selectedId === t.id
                          ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-800 dark:text-blue-200'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300')}>
                      <span className={cn('block truncate font-medium', !t.active && 'line-through opacity-60')}>{t.name}</span>
                      <span className="flex flex-wrap gap-1 mt-0.5">
                        {t.isDefault && <span className="text-[9px] uppercase px-1 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Default</span>}
                        {t.builtIn && <span className="text-[9px] uppercase px-1 rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">Built-in</span>}
                        {!t.active && <span className="text-[9px] uppercase px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">Inactive</span>}
                        {/* Tooltip carries the ⚠ FLAGS, not the whole note — a
                            2,000-character native tooltip is unreadable. */}
                        {noteIsFlagged(t.notes) && (
                          <span className="text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                            title={splitThemeNote(t.notes).flags.map((f) => `⚠ ${f}`).join('\n\n')}>
                            ⚠ draft copy
                          </span>
                        )}
                        {usage && (
                          <span className="text-[9px] px-1 rounded bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                            title={`eBay listing families on ${market} explicitly assigned to this theme`}>
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
                  )
                })
              )}
            </div>
            {usageError ? (
              <div className="mt-1 pt-1.5 border-t border-slate-200 dark:border-slate-700 px-1">
                <Pill tone="neutral" >
                  <span title={`Usage counts failed to load: ${usageError}`}>usage unavailable</span>
                </Pill>
              </div>
            ) : usage ? (
              <p className="mt-1 pt-1.5 border-t border-slate-200 dark:border-slate-700 text-[10px] leading-4 text-slate-400 px-1"
                title={`Counts read from each ${market} eBay listing family's theme assignment`}>
                {usage.total} {market} families · {usage.default} on default · {usage.raw} raw (no theme)
              </p>
            ) : null}
          </div>

          {/* CENTER — editor.
              The scroll container is load-bearing: a long theme note (the
              built-in "Xavia Modernist" note is ~2,000 chars) used to grow the
              banners past this column's height and, with nothing clipping it,
              paint straight over the push dock below — two texts on top of each
              other, neither readable. `overflow-y-auto` (not `hidden`) so that
              when the push dock expands and squeezes this column, the editor
              SCROLLS instead of losing its bottom half. */}
          <div ref={editorBoxRef} className="flex-1 min-w-0 flex flex-col gap-2 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="shrink-0 flex items-center gap-2">
              <Input value={draft.name} placeholder="Theme name…" aria-label="Theme name"
                onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); setDirty(true) }}
                fieldClassName="flex-1 min-w-0" />
              {dirty && (
                <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                  title="Unsaved edits — ⌘S / Ctrl+S or the Save button persists them" data-testid="description-dirty-dot">
                  <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" aria-hidden /> unsaved
                </span>
              )}
              {selected && (
                <>
                  <Button size="sm" variant="ghost" title="Duplicate into a new theme" onClick={() => void startNew(selected)}>
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="sm" variant={selected.isDefault ? 'primary' : 'ghost'}
                    title={selected.isDefault ? 'Unset as default' : 'Set as the default theme (wraps every listing without its own pick)'}
                    onClick={() => void setDefault(selected)} disabled={busy}>
                    <Star className={cn('w-3.5 h-3.5', selected.isDefault && 'fill-current')} />
                  </Button>
                  <Checkbox checked={draft.active} label="Active"
                    title="Inactive themes never render — listings fall back to the default"
                    onChange={(e) => { setDraft((d) => ({ ...d, active: e.target.checked })); setDirty(true) }} />
                  {!selected.builtIn && (
                    <Button size="sm" variant="ghost" title="Delete theme" onClick={() => void remove(selected)} disabled={busy}>
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </Button>
                  )}
                </>
              )}
            </div>
            {/* Notes hold multi-paragraph design/compliance records — a
                single-line Input made them unreadable and unreviewable. */}
            <Textarea value={draft.notes} rows={2} spellCheck={false}
              placeholder="Notes (optional)… a ⚠ marks copy that still needs operator sign-off"
              aria-label="Theme notes"
              className="shrink-0 w-full text-[11.5px] leading-5 resize-y"
              // The DS textarea floors at 168px — right for a paste box, far
              // too tall for a 2-line notes field. Inline so it beats the
              // stylesheet regardless of CSS load order.
              style={{ minHeight: 52 }}
              onChange={(e) => { setDraft((d) => ({ ...d, notes: e.target.value })); setDirty(true) }} />

            {/* Bounded, scrollable banner stack — see the column comment above. */}
            <div className="shrink-0 max-h-[32vh] overflow-y-auto flex flex-col gap-2 empty:hidden">
              {/* a ⚠ in the notes marks copy pending operator sign-off */}
              {noteIsFlagged(draft.notes) && (
                <Banner tone="warning" title="Draft copy — operator sign-off required before assigning to live listings">
                  <ThemeNote notes={draft.notes} />
                </Banner>
              )}
              {actionError && (
                <Banner tone="danger" title="Action failed" onDismiss={() => setActionError(null)}>
                  {actionError}
                </Banner>
              )}
              {conflict && (
                <Banner tone="danger"
                  title={`Save conflict — this theme was modified elsewhere${conflict.currentVersion != null ? ` (now v${conflict.currentVersion})` : ''}`}
                  action={<Button size="sm" onClick={() => void reloadTheme()}>Reload theme (discards draft)</Button>}>
                  Nothing was saved; the editor still shows YOUR draft. Reload to take the other session's version, or
                  copy your HTML out before reloading.
                </Banner>
              )}
            </div>

            {/* Fixed-size palette (17 tokens) — never capped: clipping a token
                row mid-glyph reads as a rendering fault, and the list can't
                grow at runtime. */}
            <div className="shrink-0 flex flex-wrap gap-1">
              {THEME_TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insertToken(t)}
                  // Keep the textarea focused so "insert at the cursor" means
                  // the operator's cursor, not wherever a blur left it.
                  onMouseDown={(e) => e.preventDefault()}
                  title={`${THEME_TOKEN_INFO[t]}\n\nClick to insert at the cursor.`}
                  className="px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-[10px] font-mono hover:bg-violet-100 dark:hover:bg-violet-900/40">
                  {t}
                </button>
              ))}
            </div>
            <Textarea value={draft.html} spellCheck={false} aria-label="Theme HTML"
              // insertToken() finds THIS textarea by role — the notes field is
              // also a <textarea> now, and a bare querySelector('textarea')
              // would paste tokens into the notes instead of the HTML.
              data-role="theme-html"
              onChange={(e) => { setDraft((d) => ({ ...d, html: e.target.value })); setDirty(true) }}
              className="flex-1 w-full text-xs font-mono resize-none"
              // Overrides the DS 168px floor so the editor can give height back
              // to the banner stack instead of overflowing the pane.
              style={{ minHeight: 150 }}
              placeholder="Theme HTML with {{tokens}}…" />
          </div>

          {/* RIGHT — always-mounted preview + status strip. Same rule as the
              editor: contained, and scrolls rather than clipping the status
              strip away when the dock takes the height. */}
          <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0 overflow-y-auto overflow-x-hidden">
            <div className="shrink-0 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                Preview (as pushed){previewProduct ? ` — ★ ${previewProduct.sku} · ${market}` : ''}
              </span>
              <button type="button" onClick={() => setRefreshTick((n) => n + 1)} disabled={render.phase === 'rendering'} title="Re-render now"
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
                <RefreshCw className={cn('w-3 h-3', render.phase === 'rendering' && 'animate-spin')} /> Refresh
              </button>
            </div>
            <div ref={previewBoxRef} className="flex-1 min-h-[180px] overflow-auto rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60 p-3">
              {srcDoc ? (
                // A FAILED render dims the last good frame — never blanks it.
                <div className={cn('mx-auto overflow-hidden rounded shadow-sm transition-opacity', render.phase === 'failed' && 'opacity-40')}
                  style={{ width: Math.round(frameW * frameScale), height: frameH }}>
                  <div style={{ transform: `scale(${frameScale})`, transformOrigin: 'top left', width: frameW, height: frameH / frameScale }}>
                    <iframe title="Description preview (as pushed)" sandbox="" srcDoc={srcDoc}
                      className="bg-white border-0" style={{ width: frameW, height: frameH / frameScale }} />
                  </div>
                </div>
              ) : (
                <p className="text-xs text-slate-400 px-2 py-6 text-center">
                  {render.phase === 'rendering'
                    ? 'Rendering exactly what a push would send…'
                    : render.phase === 'failed'
                      ? 'Render failed before any preview existed — the status strip below has the exact error.'
                      : !previewProduct
                        ? 'Add a product above and star it — previews render with a real product’s images, specs and content.'
                        : !draft.html.trim()
                          ? 'Add theme HTML in the editor first.'
                          : 'Nothing rendered yet — the preview updates automatically as you type.'}
                </p>
              )}
            </div>
            {frameScale < 1 && srcDoc && (
              <p className="shrink-0 text-[10px] text-slate-400 text-center">Desktop frame is {frameW}px, scaled to {Math.round(frameScale * 100)}% to fit.</p>
            )}
            <StatusStrip
              render={render}
              onRetryRender={() => setRefreshTick((n) => n + 1)}
              dirty={dirty}
              isNew={isNew}
              savedName={selected?.name ?? null}
              savedVersion={selected?.version ?? null}
              themeInactive={!!selected && !selected.active}
              staleEntry={previewProduct ? staleness[previewProduct.id] ?? null : null}
              stalenessError={previewProduct ? stalenessError : null}
              skuById={skuById}
            />
          </div>
        </div>

        {/* ── push dock (collapsible).
            Opaque, and stacked above the panes: this is the surface that gets
            read while a live write is being decided, so nothing may ever show
            through it. */}
        <div className="shrink-0 relative z-[1] bg-[var(--surface-card)] border-t border-slate-200 dark:border-slate-700 pt-1.5 flex flex-col">
          <button type="button" onClick={() => setDockOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-1 py-1 text-left rounded hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
            aria-expanded={dockOpen}>
            {dockOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-400" />}
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
              Push to eBay — {products.length} product{products.length === 1 ? '' : 's'} · {market}
            </span>
            {dockPill && <Pill tone={dockPill.tone}>{dockPill.label}</Pill>}
            <span className="ml-auto text-[10px] text-slate-400">{dockOpen ? 'collapse' : 'expand'}</span>
          </button>

          {dockOpen && (
            <div className="max-h-[42vh] overflow-y-auto pr-1 mt-1.5 flex flex-col gap-2">
              {/* The theme's ⚠ draft-copy note repeats HERE, inside the push
                  flow — the flags in full, the long-form record one click away
                  (ThemeNote). Dumping the whole note inline is what buried this
                  dock under a wall of amber text. */}
              {selected && pushDraftCopy && (
                <Banner tone="warning" title={`Draft copy — theme "${selected.name}" is flagged ⚠ in its notes`}>
                  <div className="flex flex-col gap-1.5">
                    <p>Pushing puts this DRAFT text on live listings. The confirmation step repeats it before anything is sent.</p>
                    <ThemeNote notes={selected.notes} />
                  </div>
                </Banner>
              )}
              <p className="text-[11px] text-slate-400">
                Each chip resolves to its whole family: the push revises the description of EVERY live eBay
                listing of that family on {market} — the primary listing plus adopted shared listings. Price,
                quantity, title and variations never change. Max {MAX_PUSH_PRODUCTS} products per push.
              </p>
              <StalenessPill
                entries={products.map((p) => staleness[p.id]).filter((e): e is StalenessEntry => !!e)}
                skuById={skuById}
                checkError={products.length > 0 ? stalenessError : null}
              />
              <div className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 flex flex-col gap-1.5">
                {/* Always-present push button — blocked states DISABLE it with the reason underneath, never hide it.
                    `variant="danger"` is the DS token now; this used to carry a
                    stack of !important red overrides that no theme could touch. */}
                <Button size="sm" variant="danger" className="self-start max-w-full"
                  disabled={!!pushBlockReason || pushBusy || confirmOpen}
                  data-testid="description-push-button"
                  onClick={() => void runPush()}>
                  {pushBusy
                    ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Pushing…</span>
                    : <><Send className="w-3.5 h-3.5" /><span className="truncate">{`Push descriptions — ${products.length} product${products.length === 1 ? '' : 's'} → all live listings · theme "${selected?.name ?? (draft.name || '—')}" · ${market}`}</span></>}
                </Button>
                {pushBlockReason ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{pushBlockReason}</p>
                ) : (
                  <p className="text-[10px] text-slate-400">
                    Revises LIVE listings after an explicit confirmation. The exact listing count is resolved at
                    push time — every ItemID then appears below with its outcome and every warning, verbatim.
                  </p>
                )}
              </div>
              {/* Outcome lands here — scrolled into view automatically, because
                  the dock scrolls and a per-listing report the operator never
                  sees is the same as no report. */}
              <div ref={pushOutcomeRef} className="flex flex-col gap-2 empty:hidden">
                {pushError && (
                  <Banner tone="danger" title="Push request failed — nothing was confirmed as revised">
                    {pushError}
                  </Banner>
                )}
                {/* Results persist until the drawer closes. */}
                {pushResult && <PushResults res={pushResult.res} themeName={pushResult.themeName} at={pushResult.at} />}
              </div>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}
