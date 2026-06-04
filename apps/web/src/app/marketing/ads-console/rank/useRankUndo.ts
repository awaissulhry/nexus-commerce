'use client'

/**
 * RC4.6 — change history + undo/redo for the Rank cockpit.
 *
 * History is the persisted audit trail (CampaignBidHistory via /history). "Undo"
 * a keyword/target bid change by re-staging its oldValue through the gated
 * bid path — itself auditable + cancellable. Sequential undo walks back through
 * REAL changes (skipping its own reverse entries, which carry an "Undo:"/"Redo"
 * reason). Redo re-applies. Per-entry undo (any specific change) powers the
 * History tab; undo()/redo() power the toolbar buttons + Cmd+Z / Cmd+Shift+Z.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { type HistEntry, fmtEur, pickUndoTarget } from './rank-undo-logic'

export type { HistEntry } from './rank-undo-logic'
export { fmtEur, pickUndoTarget } from './rank-undo-logic'

export function useRankUndo(campaignId: string, onChanged?: () => void) {
  const [entries, setEntries] = useState<HistEntry[]>([])
  const [consumed, setConsumed] = useState<Set<string>>(new Set())
  const [redoStack, setRedoStack] = useState<{ entityId: string; bidCents: number; sourceId: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const reload = useCallback(async (signal?: AbortSignal) => {
    if (!campaignId) { setEntries([]); return }
    try { const d = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaignId}/history?limit=80`, { cache: 'no-store', signal }).then(r => r.json()); if (!signal?.aborted) setEntries((d.entries ?? []) as HistEntry[]) } catch { /* ignore */ }
  }, [campaignId])

  useEffect(() => { const ac = new AbortController(); setConsumed(new Set()); setRedoStack([]); void reload(ac.signal); return () => ac.abort() }, [reload])

  const applyBid = useCallback(async (entityId: string, bidCents: number, reason: string) => {
    await fetch(`${getBackendUrl()}/api/advertising/ad-targets/bulk-bid`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: [{ adTargetId: entityId, bidCents }], reason }) })
  }, [])

  const undoEntry = useCallback(async (e: HistEntry) => {
    if (!e.undoable || e.oldValue == null || busy) return
    setBusy(true)
    await applyBid(e.entityId, Number(e.oldValue), `Undo: bid ${fmtEur(Number(e.newValue ?? 0))}→${fmtEur(Number(e.oldValue))}`)
    setConsumed(s => new Set(s).add(e.id))
    setRedoStack(s => [{ entityId: e.entityId, bidCents: Number(e.newValue ?? e.oldValue), sourceId: e.id }, ...s])
    setToast(`Undid bid → ${fmtEur(Number(e.oldValue))} (staged)`)
    await reload(); setBusy(false); onChanged?.()
  }, [applyBid, busy, reload, onChanged])

  const nextUndo = useMemo(() => pickUndoTarget(entries, consumed), [entries, consumed])

  const undo = useCallback(async () => { if (nextUndo) await undoEntry(nextUndo) }, [nextUndo, undoEntry])

  const redo = useCallback(async () => {
    const r = redoStack[0]; if (!r || busy) return
    setBusy(true)
    await applyBid(r.entityId, r.bidCents, 'Redo (RC4.6)')
    setRedoStack(s => s.slice(1))
    setConsumed(s => { const n = new Set(s); n.delete(r.sourceId); return n })
    setToast(`Redone → ${fmtEur(r.bidCents)} (staged)`)
    await reload(); setBusy(false); onChanged?.()
  }, [redoStack, applyBid, busy, reload, onChanged])

  return { entries, reload, undo, redo, undoEntry, canUndo: !!nextUndo && !busy, canRedo: redoStack.length > 0 && !busy, busy, toast, setToast }
}

export type RankUndoApi = ReturnType<typeof useRankUndo>
