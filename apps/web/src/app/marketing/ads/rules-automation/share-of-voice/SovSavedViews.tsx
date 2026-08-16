'use client'

/**
 * SOV.6 — saved views. **A URL and a name. Nothing else.**
 *
 * 🔴 It captures the QUESTION, never the answer. A view that pinned 2026-07-19 with its rows would
 * still be serving that week in October — a worse version of the defect the freshness reckoning
 * exists to fix, because at least the page tells you when it is declining data. So what is stored is
 * the query string, and every open re-resolves it against the gate's current choice.
 *
 * 🔴 No new table, no new route, no migration. `SavedView` already exists and is already scoped by
 * `(userId, surface)` with a uniqueness constraint on the name, and `/api/saved-views` already has
 * the full CRUD — it is what /products, /listings and the dashboard use. This page is one more
 * `surface` value. Checked before building, per the brief: the only thing that was missing was a
 * caller.
 *
 * The one thing this page adds on top: a view whose URL carries `?period=` is MARKED in the list,
 * because it pins a deliberately-incomplete week and a name alone would not say so.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bookmark, Check, Trash2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

/** This page's own corner of a table eleven other surfaces already share. */
export const SOV_SURFACE = 'ads-share-of-voice'

interface SavedView {
  id: string
  name: string
  /** `{ qs }` — the query string, and deliberately nothing else. */
  filters: { qs?: string } | null
}

export function SovSavedViews({ currentQs, onApply }: { currentQs: string; onApply: (qs: string) => void }) {
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<SavedView[] | null>(null)
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/saved-views?surface=${SOV_SURFACE}`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`could not load saved views (${r.status})`)
      const j = await r.json()
      // 🔴 The list comes back as `{ items: [...] }`. Measured against the deployed route, not
      // assumed: this component first read `j.views`, so it would have listed NOTHING no matter how
      // many views existed — and the `catch` below turned that into "No saved views yet", which is
      // the `.catch(() => [])` trap this programme has now paid for four times. `views` and a bare
      // array are still accepted because two other surfaces call the same route and this file
      // should not be the thing that breaks if one of them normalises it.
      const items = Array.isArray(j?.items) ? j.items
        : Array.isArray(j?.views) ? j.views
          : Array.isArray(j) ? j : []
      setViews(items)
      setErr(null)
    } catch (e) {
      // An empty list and a failed read are different facts and must not share a rendering.
      setViews([])
      setErr((e as Error).message)
    }
  }, [])
  useEffect(() => { if (open) void load() }, [open, load])

  const save = async () => {
    const n = name.trim()
    if (!n) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/saved-views`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // The QUESTION, not the answer. `qs` is re-resolved on every open.
        body: JSON.stringify({ name: n, surface: SOV_SURFACE, filters: { qs: currentQs } }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `save failed (${r.status})`)
      setName(''); await load()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/saved-views/${id}`, { method: 'DELETE' })
      await load()
    } finally { setBusy(false) }
  }

  return (
    <span className="h10-sov-saved">
      <button type="button" className="h10-sov-toggle" onClick={() => setOpen((o) => !o)} title="Save this view, or open one you saved. A saved view stores the URL — never the data — so it re-resolves against the newest complete week every time you open it.">
        <Bookmark size={12} /> Views{views?.length ? ` (${views.length})` : ''}
      </button>

      {open && (
        <div className="h10-sov-savedpop">
          <div className="h10-sov-savedrow">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save() }}
              placeholder="Name this view…"
              aria-label="Name this view"
            />
            <button type="button" className="h10-am-btn sm" disabled={!name.trim() || busy} onClick={() => void save()}>
              <Check size={12} /> Save
            </button>
            <button type="button" className="x" onClick={() => setOpen(false)} aria-label="Close"><X size={13} /></button>
          </div>

          {err && <p className="h10-sov-savederr">{err}</p>}

          <p className="h10-sov-savednote">
            A view stores this page’s URL, not its data — it re-resolves against the newest complete
            week every time you open it.
          </p>

          {views == null ? <p className="h10-sov-savednote">Loading…</p>
            : views.length === 0 && !err ? <p className="h10-sov-savednote">No saved views yet.</p>
              : views.length === 0 ? null
              : (
                <ul className="h10-sov-savedlist">
                  {views.map((v) => {
                    // A pinned week cannot be inferred from a name, so the list says it.
                    const pinned = /(^|&)period=/.test(v.filters?.qs ?? '')
                    return (
                      <li key={v.id}>
                        <button type="button" className="nm" onClick={() => { onApply(v.filters?.qs ?? ''); setOpen(false) }}>
                          {v.name}
                          {pinned && (
                            <span className="pin" title="This view pins a specific week with ?period=, including one the completeness gate declined. Its shares may under-report.">
                              <AlertTriangle size={10} /> pinned week
                            </span>
                          )}
                        </button>
                        <button type="button" className="del" onClick={() => void remove(v.id)} aria-label={`Delete ${v.name}`} disabled={busy}>
                          <Trash2 size={12} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
        </div>
      )}
    </span>
  )
}
