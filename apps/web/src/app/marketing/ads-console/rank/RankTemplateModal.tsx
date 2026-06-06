'use client'

/**
 * RTPL — named, server-saved rank-SCHEDULE templates. Replaces the old single-slot
 * browser-localStorage Save/Load. Save the current painted schedule (windows +
 * baseline) under a name, then Load any saved template onto any product/campaign.
 * Account-global, so a schedule painted once is reusable everywhere.
 */

import { useCallback, useEffect, useState } from 'react'
import { Save, Trash2, Download, Pencil } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

type Win = { days: number[]; startHour: number; endHour: number; targetKey?: string }
interface Tpl { id: string; name: string; windows: Win[]; defaultTargetKey: string | null; updatedAt: string }
const api = (p: string) => `${getBackendUrl()}/api/advertising${p}`

export function RankTemplateModal({ open, onClose, currentWindows, currentBaseline, onLoad }: {
  open: boolean
  onClose: () => void
  currentWindows: Win[]
  currentBaseline: string
  onLoad: (windows: Win[], baseline: string | null) => void
}) {
  const [items, setItems] = useState<Tpl[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = useCallback(() => { fetch(api('/rank-templates'), { cache: 'no-store' }).then(r => r.json()).then(j => setItems(j.items || [])).catch(() => {}) }, [])
  useEffect(() => { if (open) { load(); setName(''); setMsg('') } }, [open, load])
  if (!open) return null

  const saveNew = async () => {
    if (!name.trim()) { setMsg('Name your template first.'); return }
    setBusy(true); setMsg('')
    try { await fetch(api('/rank-templates'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), windows: currentWindows, defaultTargetKey: currentBaseline || null }) }); setName(''); setMsg('Saved.'); load() } catch { setMsg('Save failed.') } finally { setBusy(false) }
  }
  const overwrite = async (id: string) => { setBusy(true); setMsg(''); try { await fetch(api(`/rank-templates/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windows: currentWindows, defaultTargetKey: currentBaseline || null }) }); setMsg('Template updated with the current schedule.'); load() } finally { setBusy(false) } }
  const rename = async (id: string, cur: string) => { const n = typeof window !== 'undefined' ? window.prompt('Rename template', cur) : null; if (!n?.trim()) return; setBusy(true); try { await fetch(api(`/rank-templates/${id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n.trim() }) }); load() } finally { setBusy(false) } }
  const del = async (id: string, n: string) => { if (typeof window !== 'undefined' && !window.confirm(`Delete template "${n}"?`)) return; setBusy(true); try { await fetch(api(`/rank-templates/${id}`), { method: 'DELETE' }); load() } finally { setBusy(false) } }
  const doLoad = (t: Tpl) => { onLoad(t.windows || [], t.defaultTargetKey); onClose() }

  return (
    <div className="az-rd-copymodal" role="dialog" aria-modal="true" aria-label="Schedule templates" onClick={onClose}>
      <div className="box" onClick={e => e.stopPropagation()} style={{ width: 'min(520px, 94vw)' }}>
        <div className="hd">Schedule templates<span className="grow" /><button type="button" className="az-kebab" onClick={onClose} aria-label="Close">✕</button></div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 15px', borderBottom: '1px solid var(--border)' }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name this schedule (e.g. Evenings push)" style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 6, padding: '6px 9px', font: 'inherit', fontSize: 12.5 }} onKeyDown={e => { if (e.key === 'Enter') void saveNew() }} />
          <button type="button" className="az-btn dark sm" disabled={busy || !currentWindows.length} onClick={() => void saveNew()} title={currentWindows.length ? 'Save the current painted schedule as a new template' : 'Paint a schedule first'}><Save size={13} /> Save current</button>
        </div>
        <div className="list">
          {items.length === 0 && <div className="az-rp-empty">No templates yet — name the current schedule above and Save it.</div>}
          {items.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }} title={t.name}>{t.name}</span>
              <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{(t.windows || []).length} window{(t.windows || []).length === 1 ? '' : 's'}{t.defaultTargetKey ? ` · baseline ${t.defaultTargetKey}` : ''}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="az-btn sm" disabled={busy} onClick={() => doLoad(t)} title="Paint this schedule into the grid"><Download size={12} /> Load</button>
              <button type="button" className="az-kebab" disabled={busy} onClick={() => void overwrite(t.id)} title="Overwrite with the current schedule"><Save size={13} /></button>
              <button type="button" className="az-kebab" disabled={busy} onClick={() => void rename(t.id, t.name)} title="Rename"><Pencil size={13} /></button>
              <button type="button" className="az-kebab" disabled={busy} style={{ color: '#cc1100' }} onClick={() => void del(t.id, t.name)} title="Delete"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
        {msg && <div className="az-rp-msg" style={{ margin: '0 15px' }}>{msg}</div>}
        <div className="ft"><span className="cnt">{items.length} saved · loads onto any product or campaign</span><span className="grow" /><button type="button" className="az-btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}
