'use client'

/**
 * Customise columns — faithful re-creation of the Amazon Ads "Customise columns"
 * modal. Left category nav · middle "Available columns" (search + select-all,
 * grouped to the chosen category) · right "N selected" reorderable list with
 * drag handles. Active status + Campaign name are locked (always shown, pinned
 * first). Apply commits the ordered selection back to the table.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Search, GripVertical, Lock, Check } from 'lucide-react'
import { COLUMN_META, CATEGORIES, META_BY_KEY, type ColCategory } from './columns'

const LOCKED = COLUMN_META.filter((c) => c.locked)
const MANAGEABLE = COLUMN_META.filter((c) => !c.locked)

export function CustomiseColumns({
  visible, onClose, onApply,
}: {
  visible: string[]
  onClose: () => void
  onApply: (next: string[]) => void
}) {
  const [draft, setDraft] = useState<string[]>(visible)
  const [cat, setCat] = useState<ColCategory | 'All'>('All')
  const [q, setQ] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // available list = manageable columns filtered by category + search
  const available = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return MANAGEABLE.filter((c) =>
      (cat === 'All' || c.category === cat) &&
      (!ql || c.label.toLowerCase().includes(ql) || c.category.toLowerCase().includes(ql)),
    )
  }, [cat, q])

  const selectedSet = useMemo(() => new Set(draft), [draft])
  const allFilteredSelected = available.length > 0 && available.every((c) => selectedSet.has(c.key))

  const toggle = (key: string) =>
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]))

  const selectAllFiltered = () =>
    setDraft((d) => {
      if (allFilteredSelected) { const f = new Set(available.map((c) => c.key)); return d.filter((k) => !f.has(k)) }
      const add = available.map((c) => c.key).filter((k) => !d.includes(k))
      return [...d, ...add]
    })

  // drag-reorder within the selected list
  const onDrop = (target: string) => {
    if (!dragKey || dragKey === target) { setDragKey(null); setOverKey(null); return }
    setDraft((d) => {
      const next = d.filter((k) => k !== dragKey)
      const at = next.indexOf(target)
      next.splice(at < 0 ? next.length : at, 0, dragKey)
      return next
    })
    setDragKey(null); setOverKey(null)
  }

  const countInCat = (c: ColCategory | 'All') =>
    c === 'All' ? draft.length : draft.filter((k) => META_BY_KEY[k]?.category === c).length

  return (
    <div className="az-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="az-modal" role="dialog" aria-modal="true" aria-label="Customise columns" ref={dialogRef} tabIndex={-1}>
        <div className="az-modal-head">
          <h2>Customise columns</h2>
          <button className="x" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="az-modal-sub">Choose which columns appear and drag to reorder them. Active status and Campaign name are always shown.</div>

        <div className="az-modal-body">
          {/* category nav */}
          <div className="az-cc-cats">
            {(['All', ...CATEGORIES] as Array<ColCategory | 'All'>).map((c) => (
              <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
                <span>{c}{c === 'Profitability' && <span className="nx"> ✦</span>}</span>
                <span className="ct">{countInCat(c)}</span>
              </button>
            ))}
          </div>

          {/* available columns */}
          <div className="az-cc-avail">
            <div className="az-cc-h">
              <div className="az-search" style={{ flex: 1, minWidth: 0, padding: '6px 10px' }}>
                <Search size={14} />
                <input placeholder="Find a column" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a column" />
              </div>
              <button className="az-link" onClick={selectAllFiltered}>{allFilteredSelected ? 'Deselect all' : 'Select all'}</button>
            </div>
            <div className="az-cc-list">
              {available.length === 0 && <div style={{ padding: 16, color: 'var(--ink2)' }}>No columns match “{q}”.</div>}
              {available.map((c) => (
                <label key={c.key} className="az-cc-row">
                  <input type="checkbox" checked={selectedSet.has(c.key)} onChange={() => toggle(c.key)} />
                  <span>
                    <span className="lab">{c.label}</span>
                    {c.nexus && <span className="nx">NEXUS</span>}
                    {c.desc && <div className="d">{c.desc}</div>}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* selected (reorderable) */}
          <div className="az-cc-sel">
            <div className="az-cc-h">
              <span className="t" style={{ flex: 1 }}><span className="n">{LOCKED.length + draft.length}</span> selected</span>
              <button className="az-link" onClick={() => setDraft([])} disabled={draft.length === 0} style={draft.length === 0 ? { opacity: .4, cursor: 'default' } : undefined}>Remove all</button>
            </div>
            <div className="az-cc-chips">
              {LOCKED.map((c) => (
                <div key={c.key} className="az-cc-chip locked">
                  <Lock className="lk" size={13} />
                  <span className="lab">{c.label}</span>
                </div>
              ))}
              {draft.map((key) => {
                const c = META_BY_KEY[key]; if (!c) return null
                return (
                  <div
                    key={key}
                    className={`az-cc-chip ${dragKey === key ? 'drag' : ''} ${overKey === key ? 'over' : ''}`}
                    draggable
                    onDragStart={() => setDragKey(key)}
                    onDragEnd={() => { setDragKey(null); setOverKey(null) }}
                    onDragOver={(e) => { e.preventDefault(); if (overKey !== key) setOverKey(key) }}
                    onDrop={() => onDrop(key)}
                  >
                    <GripVertical className="grip" size={15} />
                    <span className="lab">{c.label}</span>
                    <button className="rm" onClick={() => toggle(key)} aria-label={`Remove ${c.label}`}><X size={14} /></button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="az-modal-foot">
          <button className="az-btn" onClick={onClose}>Cancel</button>
          <button className="az-btn dark" onClick={() => onApply(draft)}><Check size={15} /> Apply</button>
        </div>
      </div>
    </div>
  )
}
