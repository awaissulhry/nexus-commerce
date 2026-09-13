'use client'

/**
 * GDS / PES.2 — the VIEWS menu: presets the product ships with, and views the operator saved.
 *
 * EXTRACTED, not rewritten. This is `app/products/next/GridViewsMenu.tsx` moved into the design
 * system unchanged in behaviour, plus a presets section. It was always generic — it takes a
 * `GridStateApi<TPage>` and nothing page-shaped — and every rebuilt surface needs it, so a copy per
 * lane was the fork the DS rules exist to prevent. The /products/next file is now a re-export.
 *
 * Two kinds of thing in one menu, on purpose:
 *   PRESETS  declared in code, same for everyone, cannot be deleted — "All attributes", "Pricing"
 *   VIEWS    the operator's own, on the server, named, default-able
 * An operator does not distinguish them ("show me pricing"), so the menu does not make them, beyond
 * a separator and the fact that only a saved view can be renamed, duplicated, updated or deleted.
 *
 * 2026-09-04 (design V.4/V.9): the menu manages views as a first-class object — New view… (opens
 * the sheet's builder, which is its Customise dialog), Save as view…, Update, Rename…, Duplicate…,
 * Make default / Clear default, Delete with a confirm — and a saved view can carry a NOTE from the
 * surface (the columns it names that this product type lacks). The anchored popover hosts each small conversation while the Views trigger keeps its place.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverPosition } from '../../components/usePopoverPosition'
import { useClickAway } from '../../components/useClickAway'
import { AlertTriangle, ChevronDown } from 'lucide-react'

import { Button, Input } from '@/design-system/primitives'
import { Menu, useToast, type MenuItemDef } from '@/design-system/components'

import type { GridStateApi } from '../hooks/useGridState'
import type { SavedGridView } from '../hooks/useGridViews'
import { isColumnsViewPayload } from '../views/viewPayload'
import type { GridViewPreset } from '../views/presets'

export interface GridViewsMenuProps<TPage> {
  views: Pick<GridStateApi<TPage>, 'views' | 'activeId' | 'save' | 'apply' | 'remove' | 'rename' | 'duplicate' | 'setDefault' | 'clearDefault'>
  /** Named column sets this surface ships with. Omit for a surface that has none. */
  presets?: readonly GridViewPreset[]
  /** The preset currently applied, if any — shown ticked, and named on the trigger. */
  activePresetId?: string | null
  onApplyPreset?: (preset: GridViewPreset) => void
  /** Trigger label when nothing is applied — a sheet passes "Custom (23)" for an unsaved arrangement. */
  emptyLabel?: string
  /** Append each preset's / columns view's column count to its label. A sheet turns this on. */
  showCounts?: boolean
  /** Opens the surface's view BUILDER. When given, "New view…" appears. */
  onNewView?: () => void
  /**
   * Save what is on screen as a new view. A sheet passes a columns-view writer (schema 2); a grid
   * that saves AG state omits it and gets `views.save(name)` (schema 1).
   */
  onSaveCurrent?: (name: string) => Promise<unknown>
  /** Overwrite the active saved view with what is on screen. Same default as above. */
  onUpdateCurrent?: (view: SavedGridView<TPage>) => Promise<unknown>
  /** A note under a saved view — e.g. the columns it names that this product type lacks. */
  describeView?: (view: SavedGridView<TPage>) => { note?: ReactNode; title?: string } | null
  /**
   * `minimal` (CH.1, the studio sheets, Owner 2026-09-05): pick · save · update · default · delete.
   * No "New view…", no Rename…, no Duplicate… — machinery a one-operator sheet does not need.
   * Opt-in; every other caller keeps `full` and is byte-identical on screen.
   */
  manage?: 'full' | 'minimal'
  /** Which presets appear as ITEMS. The trigger label still resolves against every preset given. */
  presetInMenu?: (preset: GridViewPreset) => boolean
}

/**
 * 🔴 A DS component must not take a host's page down because an OPTIONAL provider is absent.
 *
 * The primary fix is upstream: `GridSheet` / `GridCard` / `GridPanel` now mount the DS
 * `ToastProvider` themselves (`hosts/GridToastBoundary.tsx`, ruling #22), so a grid-hosted menu
 * always has one. This is the belt to that pair of braces — it covers a menu mounted OUTSIDE a
 * grid host, which nothing prevents, and which used to white-screen the page.
 *
 * Why the try/catch is sound: `useToast` calls `useContext` and only then throws, so the single
 * hook involved has already run by the time the error is raised. Hook ORDER is therefore identical
 * on every render, which is the thing that would make this unsafe.
 *
 * 🔴 It does NOT swallow the notification. Ruling #22's hard constraint is that a silently no-op
 * toast is forbidden — one that never appears is a silent failure, the same family as a disabled
 * control that cannot explain itself. So with no provider anywhere, BOTH outcomes are rendered
 * inline beside the trigger: the operator still learns that the view saved, and still learns why it
 * did not.
 */
function useSafeToast(): {
  toast: (msg: string, tone: 'success' | 'danger') => void
  inline: { message: string; tone: 'success' | 'danger' } | null
} {
  const [inline, setInline] = useState<{ message: string; tone: 'success' | 'danger' } | null>(null)
  let real: ReturnType<typeof useToast> | null = null
  try {
    real = useToast()
  } catch {
    real = null
  }
  if (real) return { toast: (message, tone) => real!.toast(message, tone), inline: null }
  return { toast: (message, tone) => setInline({ message, tone }), inline }
}

/** The small conversation the anchored popover is hosting, if any. */
type Prompt =
  | { mode: 'save' }
  | { mode: 'rename'; view: SavedGridView<unknown> }
  | { mode: 'duplicate'; view: SavedGridView<unknown> }
  | { mode: 'delete'; view: SavedGridView<unknown> }

export function GridViewsMenu<TPage>({
  views,
  presets = [],
  activePresetId = null,
  onApplyPreset,
  emptyLabel = 'Views',
  showCounts = false,
  onNewView,
  onSaveCurrent,
  onUpdateCurrent,
  describeView,
  manage = 'full',
  presetInMenu,
}: GridViewsMenuProps<TPage>) {
  const { toast, inline } = useSafeToast()
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const { popRef, style: promptStyle } = usePopoverPosition(!!prompt, anchorRef, { width: 'auto', align: 'start' })
  const closePrompt = () => { setPrompt(null); anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
  useClickAway([anchorRef, popRef], () => { if (!busy) closePrompt() }, !!prompt)
  useEffect(() => {
    if (!prompt) return
    popRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => { anchorRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }
  }, [prompt, popRef])
  const active = views.views.find((v) => v.id === views.activeId) ?? null
  const activePreset = presets.find((p) => p.id === activePresetId) ?? null

  const run = (label: string, fn: () => Promise<unknown>) => {
    setBusy(true)
    return fn()
      .then(() => { toast(label, 'success'); setPrompt(null) })
      .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))
      .finally(() => setBusy(false))
  }

  const count = (n: number) => (showCounts ? ` (${n})` : '')
  const countOf = (v: SavedGridView<TPage>) => (isColumnsViewPayload(v.payload) ? count(v.payload.columns.length) : '')

  const presetItems: MenuItemDef[] = presets.filter((p) => (presetInMenu ? presetInMenu(p) : true)).map((p) => ({
    id: `preset:${p.id}`,
    label: (
      <>
        {p.label}{count(p.columns.length)}
        {p.id === activePresetId ? ' ✓' : ''}
      </>
    ),
    ...(p.description ? { title: p.description } : {}),
    onSelect: () => onApplyPreset?.(p),
  }))

  const savedItems: MenuItemDef[] = views.views.map((v) => {
    const d = describeView?.(v) ?? null
    return {
      id: v.id,
      label: (
        <>
          {v.name}{countOf(v)}
          {v.isDefault ? ' · default' : ''}
          {v.id === views.activeId ? ' ✓' : ''}
        </>
      ),
      ...(d?.note ? { description: d.note } : {}),
      ...(d?.title ? { title: d.title } : {}),
      onSelect: () => views.apply(v),
    }
  })

  const open = (p: Prompt, initial = '') => { setName(initial); setPrompt(p) }

  const items: MenuItemDef[] = [
    ...presetItems,
    ...(presetItems.length && savedItems.length ? [{ id: 'sep-presets', separator: true } as MenuItemDef] : []),
    ...savedItems,
    { id: 'sep-1', separator: true },
    ...(onNewView && manage === 'full' ? [{ id: 'new', label: 'New view…', onSelect: onNewView }] : []),
    { id: 'save-new', label: 'Save as view…', onSelect: () => open({ mode: 'save' }) },
    ...(active
      ? [
          {
            id: 'update',
            label: `Update “${active.name}”`,
            onSelect: () => void run('View updated', () => (onUpdateCurrent ? onUpdateCurrent(active) : views.save(active.name, { id: active.id, isDefault: active.isDefault }))),
          },
          ...(manage === 'full'
            ? [
                { id: 'rename', label: 'Rename…', onSelect: () => open({ mode: 'rename', view: active }, active.name) },
                { id: 'duplicate', label: 'Duplicate…', onSelect: () => open({ mode: 'duplicate', view: active }, `${active.name} copy`) },
              ]
            : []),
          active.isDefault
            ? { id: 'default', label: 'Clear default', onSelect: () => void run('Default cleared — the sheet lands on all attributes again', () => views.clearDefault(active.id)) }
            : { id: 'default', label: 'Make default', title: 'This scope lands on this view instead of all attributes', onSelect: () => void run('Default view set', () => views.setDefault(active.id)) },
          { id: 'delete', label: 'Delete…', onSelect: () => open({ mode: 'delete', view: active }) },
        ]
      : []),
  ]

  const trimmed = name.trim()
  const verb = prompt?.mode === 'save' ? 'Save view' : prompt?.mode === 'rename' ? 'Rename' : 'Duplicate'
  const submit = () => {
    if (!prompt || busy || !trimmed || prompt.mode === 'delete') return
    if (prompt.mode === 'save') return void run('View saved', () => (onSaveCurrent ? onSaveCurrent(trimmed) : views.save(trimmed)))
    if (prompt.mode === 'rename') return void run('View renamed', () => views.rename(prompt.view.id, trimmed))
    return void run('View duplicated', () => views.duplicate(prompt.view as SavedGridView<TPage>, trimmed))
  }
  const promptPanel = prompt && typeof document !== 'undefined' ? createPortal(
    <div ref={popRef} style={promptStyle} className={`nds-view-prompt${anchorRef.current?.closest('.dark') ? ' dark' : ''}`}
      role="dialog" aria-label={prompt.mode === 'delete' ? `Delete view ${prompt.view.name}` : verb}
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); closePrompt() }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); submit() }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')]
          const first = controls[0], last = controls[controls.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
      }}>
      {prompt.mode === 'delete' ? <>
        <div>Delete “{prompt.view.name}”?</div>
        <div className="nds-confirm-actions">
          <Button size="sm" data-autofocus disabled={busy} onClick={closePrompt}>Cancel</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => { if (!busy) void run('View deleted', () => views.remove(prompt.view.id)) }}>Delete</Button>
        </div>
      </> : <>
        <label className="nds-view-prompt-name">View name
          <Input data-autofocus size="sm" placeholder="View name" value={name} onChange={e => setName(e.target.value)} disabled={busy} />
        </label>
        <div className="nds-confirm-actions">
          <Button size="sm" disabled={busy} onClick={closePrompt}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!trimmed || busy} onClick={submit}>{verb}</Button>
        </div>
      </>}
    </div>, document.body) : null
  return (
    <span className="nds-grid-views" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span ref={anchorRef}><Menu
        label={<>{active ? `${active.name}${countOf(active)}` : activePreset ? `${activePreset.label}${count(activePreset.columns.length)}` : emptyLabel} <ChevronDown size={11} /></>}
        items={items}
        triggerProps={{ className: 'nds-btn sm', disabled: !!prompt || busy }}
      /></span>
      {promptPanel}
      {inline && (
        <span
          className={inline.tone === 'danger' ? 'nds-inline-error' : 'nds-cell-muted'}
          role="status"
          title={inline.message}
          style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12 }}
        >
          {inline.tone === 'danger' && <AlertTriangle size={12} />}
          {inline.message}
        </span>
      )}
    </span>
  )
}
