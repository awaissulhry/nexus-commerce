'use client'

/**
 * ⛔ PARKED 2026-08-18 (U4) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the watchlist editor modal (create, import, edit the tracked terms).
 * Why it left: the Keyword Tracker tab is now Helium 10's shape — one rules grid and nothing else
 *   (`KeywordTrackerRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.10, §7.5).
 * Candidate home: the KT rule builder's Setup step — H10 puts "+ Create New Keyword Tracker" exactly there.
 *
 * Nothing here was changed and no endpoint was retired (`/keyword-tracker`, `/keyword-watchlists`,
 * `/keyword-actions/*` are all still served). The file stays at this path on purpose: re-mounting it
 * is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * KT.2 — the watchlist editor: add, remove, import, create, rename, set default, delete.
 *
 * Every destructive control here says what it will do, to how many terms, and whether it can be
 * undone — because two of them cannot. The read-only half (the term table) stays dense and quiet.
 *
 * 🔴 The import source is a `KeywordCoverageSet`, and importing COPIES its terms. It never
 * references the set and never writes to it: that table is the ACR coverage engine's arming switch
 * (scheduled daily at 07:10; at `NEXUS_COVERAGE_ENGINE_MODE=auto` it steps the bids of an enabled
 * set's terms through the write path to Amazon). Nothing on this page can enable one, and this
 * panel deliberately offers no such control.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Download, Plus, Star, Trash2, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

export interface WatchlistRow {
  id: string
  marketplace: string
  name: string
  isDefault: boolean
  source: string
  terms: number
}

interface TermRow { id: string; term: string; isBranded: boolean; addedFrom: string | null }
interface ImportSource { id: string; name: string; marketplace: string; terms: number }

const num = (n: number) => n.toLocaleString('en-IE')
const SOURCE_WORDS: Record<string, string> = {
  'coverage-set-import': 'copied from a coverage set',
  'bid-keywords': 'the keywords we bid on that Brand Analytics can measure',
  sqp: 'Brand Analytics queries',
  manual: 'added by hand',
  import: 'imported',
}

export function WatchlistPanel({
  market, lists, activeId, onClose, onChanged,
}: {
  market: string
  lists: WatchlistRow[]
  activeId: string | null
  onClose: () => void
  /** called after any write, with the id to select (or null to keep/resolve the default) */
  onChanged: (selectId?: string | null) => void
}) {
  const [terms, setTerms] = useState<TermRow[] | null>(null)
  const [sources, setSources] = useState<ImportSource[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [paste, setPaste] = useState('')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'delete-list' | 'remove-terms' | null>(null)

  const active = lists.find((l) => l.id === activeId) ?? null

  const load = useCallback(async () => {
    if (!activeId) { setTerms([]); return }
    const [t, s] = await Promise.all([
      fetch(`${getBackendUrl()}/api/advertising/keyword-watchlists/${activeId}/terms`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`${getBackendUrl()}/api/advertising/keyword-watchlists?market=${market}`, { cache: 'no-store' }).then((r) => r.json()),
    ])
    setTerms(Array.isArray(t?.items) ? t.items : [])
    setSources(Array.isArray(s?.importSources) ? s.importSources : [])
  }, [activeId, market])

  useEffect(() => { void load() }, [load])

  const call = async (url: string, init: RequestInit, describe: (j: Record<string, unknown>) => string) => {
    setBusy(true); setErr(null); setNote(null)
    try {
      // 🔴 The JSON content-type goes on ONLY when there is a body. Fastify rejects a request that
      // declares `application/json` and sends nothing with a 400 — which is how the first Delete
      // button failed on prod: the confirmation was right, the request was malformed. Found by
      // clicking it, which is the only way this class of defect surfaces.
      const r = await fetch(`${getBackendUrl()}${url}`, {
        ...init,
        headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      })
      const j = (await r.json()) as Record<string, unknown>
      if (!r.ok || j.ok === false) throw new Error(String(j.error ?? `Request failed (${r.status})`))
      setNote(describe(j))
      return j
    } catch (e) { setErr((e as Error).message); return null } finally { setBusy(false) }
  }

  const addTerms = async () => {
    if (!activeId || !paste.trim()) return
    const j = await call(`/api/advertising/keyword-watchlists/${activeId}/terms`, {
      method: 'POST', body: JSON.stringify({ terms: [paste] }),
    }, (res) => {
      const r = res.result as { added: number; duplicates: number; invalid: number; branded: number }
      const bits = [`Added ${num(r.added)} term${r.added === 1 ? '' : 's'}`]
      if (r.duplicates) bits.push(`${num(r.duplicates)} were already on the list`)
      if (r.invalid) bits.push(`${num(r.invalid)} were blank`)
      if (r.branded) bits.push(`${num(r.branded)} classified as one of our brand terms and hidden by default`)
      return `${bits.join(' · ')}.`
    })
    if (j) { setPaste(''); await load(); onChanged(activeId) }
  }

  const removeSelected = async () => {
    if (!activeId || !sel.size) return
    const j = await call(`/api/advertising/keyword-watchlists/${activeId}/terms`, {
      method: 'DELETE', body: JSON.stringify({ termIds: [...sel] }),
    }, (res) => `Removed ${num(Number(res.removed ?? 0))} term${res.removed === 1 ? '' : 's'} from the list.`)
    if (j) { setSel(new Set()); setConfirm(null); await load(); onChanged(activeId) }
  }

  const importSet = async (setId: string) => {
    if (!activeId) return
    const j = await call(`/api/advertising/keyword-watchlists/${activeId}/import`, {
      method: 'POST', body: JSON.stringify({ coverageSetId: setId }),
    }, (res) => {
      const r = res.result as { added: number; duplicates: number; setName: string }
      return `Copied ${num(r.added)} term${r.added === 1 ? '' : 's'} from “${r.setName}”${r.duplicates ? `; ${num(r.duplicates)} were already here` : ''}. The coverage set itself was not changed.`
    })
    if (j) { await load(); onChanged(activeId) }
  }

  const createList = async () => {
    if (!newName.trim()) return
    const j = await call('/api/advertising/keyword-watchlists', {
      method: 'POST', body: JSON.stringify({ market, name: newName }),
    }, (res) => `Created “${(res.watchlist as { name: string }).name}”. It has no terms yet.`)
    if (j) { setNewName(''); onChanged((j.watchlist as { id: string }).id) }
  }

  const makeDefault = async () => {
    if (!activeId) return
    const j = await call(`/api/advertising/keyword-watchlists/${activeId}`, {
      method: 'PATCH', body: JSON.stringify({ isDefault: true }),
    }, () => `“${active?.name}” is now the list ${market} opens on.`)
    if (j) onChanged(activeId)
  }

  const deleteList = async () => {
    if (!activeId) return
    const j = await call(`/api/advertising/keyword-watchlists/${activeId}`, {
      method: 'DELETE',
    }, (res) => {
      const d = res.deleted as { name: string; terms: number; promoted: string | null }
      return `Deleted “${d.name}” and its ${num(d.terms)} term${d.terms === 1 ? '' : 's'}.${d.promoted ? ` ${market} now opens on “${d.promoted}”.` : ''}`
    })
    if (j) { setConfirm(null); onChanged(null) }
  }

  const toggle = (id: string) => {
    const next = new Set(sel)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSel(next)
  }

  return (
    <div className="h10-kt-wlpanel">
      <div className="h10-kt-wlhead">
        <div>
          <h3>Watchlist · {market}</h3>
          <p>
            {active
              ? <>“{active.name}” · {num(active.terms)} term{active.terms === 1 ? '' : 's'} · {SOURCE_WORDS[active.source] ?? active.source}{active.isDefault ? <> · <b>this market opens on it</b></> : null}</>
              : <>{market} has no watchlist. Create one below, or copy the terms out of a coverage set.</>}
          </p>
        </div>
        <button type="button" className="h10-kt-wlclose" onClick={onClose} aria-label="Close watchlist editor"><X size={15} /></button>
      </div>

      {err && <p className="h10-kt-blind"><AlertTriangle size={13} /><span>{err}</span></p>}
      {note && <p className="h10-kt-note"><Check size={13} /><span>{note}</span></p>}

      <div className="h10-kt-wlgrid">
        {/* ── add ─────────────────────────────────────────────────────── */}
        <section className="h10-kt-wlcard">
          <h4>Add terms</h4>
          <p className="cap">One per line, or separated by commas. Lowercased and de-duplicated on save.</p>
          <textarea
            className="h10-kt-wlta"
            rows={5}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={'giacca moto estiva\ncasco modulare'}
            disabled={!activeId || busy}
          />
          <button type="button" className="h10-am-btn primary" onClick={addTerms} disabled={!activeId || busy || !paste.trim()}>
            <Plus size={13} /> Add to “{active?.name ?? '—'}”
          </button>
        </section>

        {/* ── import ──────────────────────────────────────────────────── */}
        <section className="h10-kt-wlcard">
          <h4>Copy from a coverage set</h4>
          <p className="cap">
            A coverage set belongs to the coverage engine, not to this page. Importing <b>copies</b> its
            terms here and changes nothing about the set.
          </p>
          {sources.length === 0 && <p className="cap">No coverage set exists for {market}.</p>}
          {sources.map((s) => (
            <button key={s.id} type="button" className="h10-am-btn" onClick={() => importSet(s.id)} disabled={!activeId || busy}>
              <Download size={13} /> {s.name} · {num(s.terms)} terms
            </button>
          ))}
        </section>

        {/* ── the list itself ─────────────────────────────────────────── */}
        <section className="h10-kt-wlcard wide">
          <h4>This list</h4>
          <div className="h10-kt-wlterms">
            {terms == null ? <p className="cap">Loading…</p> : terms.length === 0 ? <p className="cap">No terms yet.</p> : terms.map((t) => (
              <label key={t.id} className={`h10-kt-wlterm ${sel.has(t.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} />
                <span className="t">{t.term}</span>
                {t.isBranded && <span className="bd" title="One of our own brand terms — hidden from the grid unless brand terms are included">brand</span>}
              </label>
            ))}
          </div>
          {sel.size > 0 && (
            confirm === 'remove-terms' ? (
              <p className="h10-kt-danger">
                <AlertTriangle size={13} />
                <span>
                  <b>Remove {num(sel.size)} term{sel.size === 1 ? '' : 's'} from “{active?.name}”?</b> They stop being
                  tracked and their history stops being shown here. Nothing is deleted from Amazon and no bid changes.
                  You can add them back by pasting them in again, but their notes would be lost.
                </span>
                <span className="acts">
                  <button type="button" className="h10-am-btn sm" onClick={() => setConfirm(null)}>Keep them</button>
                  <button type="button" className="h10-am-btn danger sm" onClick={removeSelected} disabled={busy}>Remove {num(sel.size)}</button>
                </span>
              </p>
            ) : (
              <button type="button" className="h10-am-btn" onClick={() => setConfirm('remove-terms')} disabled={busy}>
                <Trash2 size={13} /> Remove {num(sel.size)} selected
              </button>
            )
          )}
        </section>

        {/* ── the lists ───────────────────────────────────────────────── */}
        <section className="h10-kt-wlcard wide">
          <h4>{market} lists</h4>
          <div className="h10-kt-wllists">
            {lists.map((l) => (
              <span key={l.id} className={`h10-kt-wlrow ${l.id === activeId ? 'on' : ''}`}>
                <button type="button" className="nm" onClick={() => onChanged(l.id)}>{l.name}</button>
                <span className="ct">{num(l.terms)} terms</span>
                {l.isDefault && <span className="df"><Star size={10} /> default</span>}
              </span>
            ))}
          </div>
          <div className="h10-kt-wlnew">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={`New ${market} list name`}
              aria-label="New list name"
            />
            <button type="button" className="h10-am-btn" onClick={createList} disabled={busy || !newName.trim()}>
              <Plus size={13} /> Create
            </button>
          </div>
          {active && !active.isDefault && (
            <button type="button" className="h10-am-btn" onClick={makeDefault} disabled={busy}>
              <Star size={13} /> Make this the list {market} opens on
            </button>
          )}
          {active && (
            confirm === 'delete-list' ? (
              <p className="h10-kt-danger">
                <AlertTriangle size={13} />
                <span>
                  <b>Delete “{active.name}” and all {num(active.terms)} of its terms?</b> This cannot be undone —
                  there is no trash and the terms are not archived. Nothing on Amazon changes and no bid moves;
                  what you lose is the list and any notes on it.
                  {active.isDefault && lists.length > 1 && <> {market} would open on the oldest remaining list instead.</>}
                  {lists.length === 1 && <> It is {market}’s only list, so {market} would have no watchlist at all.</>}
                </span>
                <span className="acts">
                  <button type="button" className="h10-am-btn sm" onClick={() => setConfirm(null)}>Keep it</button>
                  <button type="button" className="h10-am-btn danger sm" onClick={deleteList} disabled={busy}>Delete the list</button>
                </span>
              </p>
            ) : (
              <button type="button" className="h10-am-btn danger" onClick={() => setConfirm('delete-list')} disabled={busy}>
                <Trash2 size={13} /> Delete “{active.name}”…
              </button>
            )
          )}
        </section>
      </div>
    </div>
  )
}
