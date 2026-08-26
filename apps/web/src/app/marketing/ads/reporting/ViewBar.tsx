'use client'

/**
 * GX.8 — the saved-view strip.
 *
 * ── Why it looks exactly like the saved-report strip ──────────────────────────
 *
 * Because it is the same gesture. `SavedReportBar` has done load / save-as / update / unsaved for
 * report definitions since RPT.5. It already owned the strip and the chip; GX.8 moved the chip
 * into the DS as `SavedChip` so both render the same one, and kept the `.rpt-saved` strip shared.
 * Reusing those classes verbatim is the point: two strips that do the same thing and look
 * slightly different is precisely the inconsistency this page is being rebuilt to remove.
 *
 * ── "Unsaved changes" has to be TRUE ─────────────────────────────────────────
 *
 * A dirty flag that is stale is worse than none — an operator rearranges a tab, sees no warning,
 * and believes the view they are about to share carries it. The panels write their state straight
 * to localStorage, which fires no event in the tab that wrote it, so the DS announces the write
 * on `prefs-bus` and this strip re-reads the keys when it hears one. That is why the bus exists.
 *
 * ── The link ─────────────────────────────────────────────────────────────────
 *
 * Copy link hands back this page's address with `?view=<id>` on it, which is resolved server-side
 * on open — so the link keeps working after the view is edited and shows what the view says NOW,
 * not what it said when the link was made. A link that froze a copy would drift silently from the
 * view it was named after.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bookmark, BookmarkPlus, Link2, Star, Trash2 } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Pill } from '@/design-system/primitives/Pill'
import { SavedChip } from '@/design-system/components/SavedChip'
import { onPrefsChanged } from '@/design-system/patterns/prefs-bus'
import { captureKeys, keysDiffer, orphanKeys, saveableTab } from './views'
import { createView, deleteView, listViews, updateView, type ReportingView } from './views-api'

export function ViewBar({
  tab, market, activeId, onApply, onActiveChange, mayAutoApply,
}: {
  tab: string
  market: string
  /** The view the page is showing, or null for "whatever the browser last had". */
  activeId: string | null
  /** Apply a view: the caller writes the keys, moves the URL and remounts the tab. */
  onApply: (view: ReportingView) => void
  onActiveChange: (id: string | null) => void
  /**
   * The page opened with no tab of its own in the address bar, so a starred view may claim it.
   * False the moment the operator has said where they want to be — a default that overrides an
   * explicit link is a link that does not work.
   */
  mayAutoApply: boolean
}) {
  const [views, setViews] = useState<ReportingView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [copied, setCopied] = useState(false)
  // Bumped whenever a panel writes, so the dirty comparison below re-reads storage.
  const [storageTick, setStorageTick] = useState(0)

  const saveable = saveableTab(tab)

  const reload = useCallback(() => {
    listViews().then(setViews).catch((e: unknown) => setError((e as Error).message))
  }, [])

  useEffect(() => { reload() }, [reload])
  useEffect(() => onPrefsChanged(() => setStorageTick((n) => n + 1)), [])

  // A key that belongs to no tab is a panel whose state no view will ever carry. Development only
  // — in production there is nothing an operator could do about it.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const orphans = orphanKeys()
    // eslint-disable-next-line no-console
    if (orphans.length) console.warn(`[views] stored keys under no tab prefix: ${orphans.join(', ')}`)
  }, [storageTick])

  const active = useMemo(() => views.find((v) => v.id === activeId) ?? null, [views, activeId])

  /**
   * Two ways a view opens by itself, and both happen AT MOST ONCE.
   *
   * A `?view=` link is resolved here rather than by a second fetch in the page — the list is
   * already on its way. A starred view claims the page only when the address bar named no tab.
   * The ref is what keeps either from firing again after `onApply` moves the URL, which would
   * put the page in a loop that quietly discards every subsequent click.
   */
  const autoApplied = useRef(false)
  useEffect(() => {
    if (autoApplied.current || views.length === 0) return
    const linked = activeId ? views.find((v) => v.id === activeId) : null
    const starred = mayAutoApply ? views.find((v) => v.isDefault) : null
    const pick = linked ?? starred
    if (!pick) return
    autoApplied.current = true
    onApply(pick)
  }, [views, activeId, mayAutoApply, onApply])

  /**
   * What is on screen right now. `storageTick` is a real dependency: it is the signal that the
   * localStorage this reads has changed underneath us.
   */
  const current = useMemo(
    () => ({ tab, market, keys: captureKeys(tab) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, market, storageTick],
  )

  const dirty = active != null && (
    active.payload.tab !== tab
    || active.payload.market !== market
    || keysDiffer(active.payload.keys, current.keys)
  )

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const doCreate = () => guard(async () => {
    const v = await createView({ name: draftName, payload: current })
    setSaveOpen(false); setDraftName('')
    onActiveChange(v.id)
    reload()
  })

  const doUpdate = () => guard(async () => {
    if (!active) return
    await updateView(active.id, { payload: current })
    reload()
  })

  const doDelete = (v: ReportingView) => guard(async () => {
    await deleteView(v.id)
    if (activeId === v.id) onActiveChange(null)
    reload()
  })

  const doDefault = (v: ReportingView) => guard(async () => {
    await updateView(v.id, { isDefault: !v.isDefault })
    reload()
  })

  const doCopyLink = useCallback(() => {
    if (!active) return
    const url = new URL(window.location.href)
    url.searchParams.set('view', active.id)
    navigator.clipboard?.writeText(url.toString())
      .then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1800) })
      .catch(() => setError('The browser refused clipboard access — the link is in the address bar once you open the view.'))
  }, [active])

  // Views are per tab. Showing a Brand view while the Business tab is open would be a control
  // that loads something other than what it names.
  const mine = views.filter((v) => v.payload.tab === tab)

  return (
    <>
      <div className="rpt-saved rpx-viewbar">
        <span className="rpt-saved-lbl">
          <Bookmark size={13} aria-hidden /> Views
        </span>

        {!saveable && (
          <span className="rpt-saved-empty">
            {tab === 'library'
              ? 'The library saves reports, not views — the strip above the runner.'
              : 'This tab keeps no settings to save; its address bar already is the link.'}
          </span>
        )}

        {saveable && mine.length === 0 && <span className="rpt-saved-empty">None yet</span>}

        {saveable && mine.map((v) => (
          <SavedChip
            key={v.id}
            label={v.name}
            meta={v.payload.market}
            active={activeId === v.id}
            title={`${v.name} — ${v.payload.market}, ${Object.keys(v.payload.keys).length} settings, updated ${new Date(v.updatedAt).toLocaleDateString('en-GB')}`}
            onSelect={() => onApply(v)}
            actions={[
              {
                icon: <Star size={12} aria-hidden fill={v.isDefault ? 'currentColor' : 'none'} />,
                label: v.isDefault ? `Stop opening "${v.name}" by default` : `Open "${v.name}" by default`,
                pressed: v.isDefault,
                disabled: busy,
                onClick: () => doDefault(v),
              },
              {
                icon: <Trash2 size={12} aria-hidden />,
                label: `Delete "${v.name}"`,
                disabled: busy,
                onClick: () => doDelete(v),
              },
            ]}
          />
        ))}

        {saveable && (
          <span className="rpt-saved-actions">
            {active && dirty && (
              <>
                <Pill tone="warning">Unsaved changes</Pill>
                <Button size="sm" variant="secondary" disabled={busy} onClick={doUpdate}>
                  Update “{active.name}”
                </Button>
              </>
            )}
            {active && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={doCopyLink}>
                <Link2 size={13} aria-hidden /> {copied ? 'Link copied' : 'Copy link'}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => { setDraftName(active ? `${active.name} copy` : ''); setSaveOpen(true) }}
            >
              <BookmarkPlus size={13} aria-hidden /> Save as…
            </Button>
          </span>
        )}
      </div>

      {error && (
        <div className="rpt-saved-err">
          {error}
          <Button size="sm" variant="ghost" onClick={() => setError(null)}>Dismiss</Button>
        </div>
      )}

      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save this view"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy || !draftName.trim()} onClick={doCreate}>Save</Button>
          </>
        )}
      >
        <div className="rpx-viewsave">
          <label htmlFor="rpx-view-name">Name</label>
          <Input
            id="rpx-view-name"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="Italy — weekly brand read"
            autoFocus
          />
          <p>
            Saves the <b>{tab === 'market-share' ? 'Market share' : tab.charAt(0).toUpperCase() + tab.slice(1)}</b> tab
            on <b>{market === 'all' ? 'every market' : market}</b>, with the{' '}
            {Object.keys(current.keys).length} {Object.keys(current.keys).length === 1 ? 'setting' : 'settings'} this
            tab is holding — which panels are shown, how wide they sit, and the columns and sort of
            every grid on it.
          </p>
          <p className="mute">
            Views live on the account, not in this browser, so the same arrangement opens on any
            machine you sign in from — and the same one everybody on the account sees.
          </p>
        </div>
      </Modal>
    </>
  )
}
