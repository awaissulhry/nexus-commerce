'use client'

/**
 * ⛔ PARKED — SG.6 (2026-08-21). NOT MOUNTED, NOT DELETED.
 *
 * What it is: the Automations section's own approval queue, on `?view=queue`.
 * Why it left: ONE INBOX. It rendered the same `/advertising/suggestions` endpoint as the
 *   Suggestions page with a third mental model — no per-family columns, no delivery truth
 *   (an apply returns at ENQUEUE; the gate settles it minutes later), no undo handle, and no
 *   lifecycle. A decision made here could not be explained anywhere. The segment now shows the
 *   count and links out; the deciding lives at /marketing/ads/suggestions.
 * Re-mounting it is one import — but read the SG record first: what this file does per-row,
 *   the Suggestions page does with the write's actual fate attached.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 *
 * AUTO.A6 — the section's ONE inbox.
 *
 * Measured: 225 pending = 8 distinct (proposedKey × entityType) decisions — the unique key
 * `(ruleId, entityId, proposedKey)` means a repeat cannot create a second row, so this is a
 * STANDING WAVE at ~20/day, not a backlog to drain. The grouping is therefore the interface: a
 * group is one decision, its rows are the entities it covers. Apply-as-proposed and
 * apply-with-edit are visibly different acts (the graduation model treats them completely
 * differently — only unchanged applies earn AUTO), so the edit path is its own control with its
 * own words, and an override still clamps to the action's own bounds server-side.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, Check, ExternalLink, RotateCcw, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Suggestion {
  id: string
  ruleId: string
  ruleName: string | null
  trigger: string | null
  marketplace: string | null
  entityType: string
  entityId: string
  entityName: string | null
  proposedAction: { type?: string; op?: string; value?: number; wouldChange?: string } & Record<string, unknown>
  proposedKey: string
  status: string
  createdAt: string
  source?: { href?: string; label?: string } | null
}

const ago = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return d < 1 ? 'today' : d === 1 ? '1 day old' : `${d} days old`
}

export function QueueView({ onDecided }: { onDecided?: () => void }) {
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions?status=pending&limit=300`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`Could not load the queue (${r.status})`)
      const j = await r.json()
      setItems(Array.isArray(j?.items) ? j.items : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setItems(null) }
  }, [])
  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => {
    const m = new Map<string, Suggestion[]>()
    for (const s of items ?? []) {
      const k = `${s.proposedKey}|${s.entityType}`
      m.set(k, [...(m.get(k) ?? []), s])
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [items])

  const decide = async (s: Suggestion, action: 'apply' | 'dismiss', value?: number) => {
    setBusy(s.id); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/${s.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: action === 'apply' && value != null ? JSON.stringify({ value }) : undefined,
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j?.error === 'automation_halted' ? 'The account is halted — nothing applies until the halt clears.' : (j?.error ?? `Failed (${r.status})`))
      setNote(action === 'apply'
        ? `Applied${value != null ? ' with your edit' : ' as proposed'} — “${s.entityName ?? s.entityId}”.${value != null ? ' An edited apply does not count toward graduation; only unchanged applies do.' : ''}`
        : `Dismissed — “${s.entityName ?? s.entityId}”.`)
      setEditing(null)
      await load()
      onDecided?.()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })

  return (
    <div className="h10-au-queue">
      {err && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}
      {note && <p className="h10-au-queuenote" role="status"><Check size={13} aria-hidden /> {note}</p>}

      {items && items.length === 0 && (
        <p className="h10-au-limitempty">The queue is empty — nothing is waiting on you.</p>
      )}

      {items && items.length > 0 && (
        <p className="h10-au-queuehead">
          <b>{items.length.toLocaleString('en-IE')} pending = {groups.length} decision{groups.length === 1 ? '' : 's'}.</b>{' '}
          The dedup key means a repeat can never stack a second row, so this is a standing wave (~20 new a day),
          not a backlog — deciding a GROUP is the unit of progress here.
        </p>
      )}

      {groups.map(([k, rows]) => {
        const first = rows[0]!
        const isOpen = open.has(k)
        return (
          <section key={k} className="h10-au-qgroup">
            <button type="button" className="h10-au-qgrouph" onClick={() => toggleOpen(k)} aria-expanded={isOpen}>
              <b>{first.proposedAction.type ?? first.proposedKey}</b>
              <span className="qk">{first.proposedKey}</span>
              <span className="qmeta">{rows.length} {first.entityType.toLowerCase()}{rows.length === 1 ? '' : 's'} · from “{first.ruleName ?? first.ruleId}” · oldest {ago(rows[rows.length - 1]!.createdAt)}</span>
            </button>
            {isOpen && (
              <ul className="h10-au-qlist">
                {rows.map((s) => (
                  <li key={s.id}>
                    <span className="qe">
                      {s.entityName ?? s.entityId}
                      {s.marketplace && <em> · {s.marketplace}</em>}
                      {s.proposedAction.wouldChange != null && <em className="qw"> — {String(s.proposedAction.wouldChange)}</em>}
                      {s.source?.href && <a href={s.source.href} title={s.source.label ?? 'Open the source'}><ExternalLink size={11} aria-hidden /></a>}
                    </span>
                    <span className="qacts">
                      {editing?.id === s.id ? (
                        <>
                          <input className="qedit" inputMode="decimal" value={editing.value} onChange={(e) => setEditing({ id: s.id, value: e.target.value })} aria-label="Edited value" autoFocus />
                          <Button variant="primary" size="sm" disabled={busy === s.id || !editing.value.trim()} onClick={() => void decide(s, 'apply', Number(editing.value))}>Apply edited</Button>
                          <Button size="sm" onClick={() => setEditing(null)}><RotateCcw size={12} aria-hidden /></Button>
                        </>
                      ) : (
                        <>
                          <Button variant="primary" size="sm" disabled={busy === s.id} onClick={() => void decide(s, 'apply')} title="Apply exactly as proposed. Unchanged applies are the evidence the graduation ladder counts.">
                            <Check size={12} aria-hidden /> Apply as proposed
                          </Button>
                          {typeof s.proposedAction.value === 'number' && (
                            <Button size="sm" disabled={busy === s.id} onClick={() => setEditing({ id: s.id, value: String(s.proposedAction.value) })} title="Change the magnitude before applying. Server-side bounds still clamp it — and an edited apply earns no graduation evidence.">
                              edit…
                            </Button>
                          )}
                          <Button size="sm" disabled={busy === s.id} onClick={() => void decide(s, 'dismiss')}><X size={12} aria-hidden /> Dismiss</Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
