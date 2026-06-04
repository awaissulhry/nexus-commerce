'use client'

/**
 * RC4.10 — Cmd+K command palette. Jump to any campaign across all markets, or run
 * a quick action (Simple/Full, open staged/history, undo/redo) without leaving the
 * keyboard. Selecting a campaign sets both its market and the campaign in one step.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, CornerDownLeft } from 'lucide-react'

interface Camp { id: string; name: string; marketplace: string | null; status: string }
export interface CmdAction { id: string; label: string; run: () => void }
type Row =
  | { kind: 'campaign'; id: string; label: string; sub: string; marketplace: string | null }
  | { kind: 'action'; id: string; label: string; sub: string; run: () => void }

export function CommandPalette({ open, onClose, campaigns, onPick, actions }: { open: boolean; onClose: () => void; campaigns: Camp[]; onPick: (id: string, marketplace: string | null) => void; actions: CmdAction[] }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (open) { setQ(''); setSel(0); const t = setTimeout(() => inputRef.current?.focus(), 30); return () => clearTimeout(t) } }, [open])

  const results = useMemo<Row[]>(() => {
    const ql = q.trim().toLowerCase()
    const acts: Row[] = (ql ? actions.filter(a => a.label.toLowerCase().includes(ql)) : actions).map(a => ({ kind: 'action', id: a.id, label: a.label, sub: 'Action', run: a.run }))
    const camps: Row[] = (ql ? campaigns.filter(c => c.name.toLowerCase().includes(ql)) : campaigns).slice(0, 8).map(c => ({ kind: 'campaign', id: c.id, label: c.name, sub: c.marketplace ?? '', marketplace: c.marketplace }))
    return [...acts, ...camps]
  }, [q, campaigns, actions])
  useEffect(() => { setSel(0) }, [q])

  if (!open) return null
  const choose = (i: number) => {
    const r = results[i]; if (!r) return
    if (r.kind === 'campaign') onPick(r.id, r.marketplace)
    else r.run()
    onClose()
  }
  return (
    <div className="az-cmdk-backdrop" onMouseDown={onClose}>
      <div className="az-cmdk" onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="az-cmdk-in">
          <Search size={15} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search campaigns or actions…" aria-label="Search campaigns or actions" onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(results.length - 1, s + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)) }
            else if (e.key === 'Enter') { e.preventDefault(); choose(sel) }
            else if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }} />
          <kbd>esc</kbd>
        </div>
        <div className="az-cmdk-list">
          {results.length === 0 ? <div className="az-cmdk-empty">No matches</div> : results.map((r, i) => (
            <button key={r.kind + r.id} type="button" className={`az-cmdk-row ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
              <span className={`tag ${r.kind}`}>{r.kind === 'action' ? 'Do' : 'Go'}</span>
              <span className="lb">{r.label}</span>
              <span className="sb">{r.sub}</span>
              {i === sel && <CornerDownLeft size={12} />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
