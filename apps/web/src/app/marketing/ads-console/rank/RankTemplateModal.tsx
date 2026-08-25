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
import { Button, Input, ToolbarButton } from '@/design-system/primitives'
import { Modal } from '@/design-system/components/Modal'

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
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="Schedule templates"
      footer={<>
        <span style={{ fontSize: 11.5, color: 'var(--ink3)' }}>{items.length} saved · loads onto any product or campaign</span>
        <span className="grow" />
        <Button onClick={onClose}>Close</Button>
      </>}
    >
      <div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', flex: 1 }}><Input aria-label="Template name" value={name} onChange={e => setName(e.target.value)} placeholder="Name this schedule (e.g. Evenings push)" onKeyDown={e => { if (e.key === 'Enter') void saveNew() }} /></div>
          <Button variant="primary" size="sm" disabled={busy || !currentWindows.length} onClick={() => void saveNew()} title={currentWindows.length ? 'Save the current painted schedule as a new template' : 'Paint a schedule first'}><Save size={13} /> Save current</Button>
        </div>
        <div>
          {items.length === 0 && <div className="az-rp-empty">No templates yet — name the current schedule above and Save it.</div>}
          {items.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 12.5 }}>
              <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }} title={t.name}>{t.name}</span>
              <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{(t.windows || []).length} window{(t.windows || []).length === 1 ? '' : 's'}{t.defaultTargetKey ? ` · baseline ${t.defaultTargetKey}` : ''}</span>
              <span style={{ flex: 1 }} />
              <Button size="sm" disabled={busy} onClick={() => doLoad(t)} title="Paint this schedule into the grid"><Download size={12} /> Load</Button>
              <ToolbarButton icon={<Save size={13} />} label="Overwrite with the current schedule" disabled={busy} onClick={() => void overwrite(t.id)} />
              <ToolbarButton icon={<Pencil size={13} />} label="Rename" disabled={busy} onClick={() => void rename(t.id, t.name)} />
              <ToolbarButton icon={<Trash2 size={13} />} label="Delete" disabled={busy} onClick={() => void del(t.id, t.name)} />
            </div>
          ))}
        </div>
        {msg && <div className="az-rp-msg">{msg}</div>}
      </div>
    </Modal>
  )
}
