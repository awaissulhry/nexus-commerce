'use client'

/**
 * Strategy Composer — drag distinct automations from the palette into your own
 * ordered strategy stack, reorder by dragging, then activate them all at once
 * (each created disabled + dry-run via /automation-rules). A power-user way to
 * assemble a bespoke winning posture beyond the preset playbooks.
 */

import { useMemo, useState } from 'react'
import { Search, GripVertical, X, Layers, Check } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { AUTOMATIONS, buildRule, type AutomationDef } from './automations'
import { CatIcon } from './_icons'
import { saveCustomPlaybook } from './customPlaybooks'

export function ComposerTab({ onSaved }: { onSaved: () => void }) {
  const [q, setQ] = useState('')
  const [stack, setStack] = useState<string[]>([])
  const [palDrag, setPalDrag] = useState<string | null>(null)
  const [stackDrag, setStackDrag] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [pbName, setPbName] = useState('')

  const palette = useMemo(() => { const ql = q.trim().toLowerCase(); return AUTOMATIONS.filter((a) => !stack.includes(a.id) && (!ql || a.name.toLowerCase().includes(ql) || a.category.toLowerCase().includes(ql))) }, [q, stack])
  const stackDefs = useMemo(() => stack.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter((a): a is AutomationDef => !!a), [stack])

  const addToStack = (id: string) => setStack((s) => (s.includes(id) ? s : [...s, id]))
  const removeFromStack = (id: string) => setStack((s) => s.filter((x) => x !== id))
  const reorder = (from: number, to: number) => setStack((s) => { const n = [...s]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n })

  const activate = async () => {
    if (!stackDefs.length) return
    setBusy(true); setMsg('')
    try {
      let added = 0
      for (const def of stackDefs) { const b = buildRule(def); const r = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: def.name, description: def.desc, trigger: def.trigger, conditions: b.conditions, actions: b.actions, maxExecutionsPerDay: b.maxExecutionsPerDay, maxDailyAdSpendCentsEur: b.maxDailyAdSpendCentsEur ?? null }) }); if (r.ok) added++ }
      setMsg(`Activated ${added} automation(s) — disabled + dry-run. Turn them on in Active rules.`); setStack([]); onSaved()
    } finally { setBusy(false) }
  }

  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ color: 'var(--ink2)', fontSize: 12.5, marginBottom: 12 }}>Drag automations from the left into your strategy, reorder them, then activate the whole stack at once. Build the exact posture you want — no presets required.</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* palette */}
        <div className="az-card" style={{ padding: 14 }}>
          <div className="az-search" style={{ marginBottom: 10 }}><Search size={15} /><input placeholder="Search automations to add…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {palette.map((a) => (
              <div key={a.id} draggable onDragStart={() => setPalDrag(a.id)} onDragEnd={() => setPalDrag(null)} onDoubleClick={() => addToStack(a.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, border: '1px solid var(--divider)', borderRadius: 8, padding: '8px 10px', cursor: 'grab', background: palDrag === a.id ? 'var(--bg3)' : '#fff' }}>
                <span style={{ color: 'var(--navy)' }}><CatIcon cat={a.category} size={15} /></span>
                <span style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, fontSize: 12.5 }}>{a.name}</span><span style={{ display: 'block', color: 'var(--ink2)', fontSize: 11 }}>{a.category}</span></span>
                <button className="az-link" onClick={() => addToStack(a.id)} style={{ fontSize: 12 }}>Add</button>
              </div>
            ))}
            {palette.length === 0 && <div style={{ color: 'var(--ink2)', fontSize: 12, padding: 12 }}>Everything matching is already in your stack.</div>}
          </div>
        </div>

        {/* stack / dropzone */}
        <div className="az-card" style={{ padding: 14, minHeight: 200, border: palDrag ? '1.5px dashed var(--orange)' : undefined }}
          onDragOver={(e) => { e.preventDefault() }} onDrop={() => { if (palDrag) addToStack(palDrag); setPalDrag(null) }}>
          <h3 style={{ margin: '0 0 4px' }}><Layers size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />Your strategy <span style={{ color: 'var(--ink2)', fontWeight: 500, fontSize: 12 }}>· {stack.length} automations</span></h3>
          <p className="desc" style={{ marginBottom: 12 }}>Drop automations here. Drag to reorder.</p>
          {stack.length === 0 && <div className="az-drop" style={{ pointerEvents: 'none' }}>Drag automations here to build your strategy</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {stackDefs.map((a, i) => (
              <div key={a.id} draggable onDragStart={() => setStackDrag(i)} onDragEnd={() => { setStackDrag(null); setOverIdx(null) }} onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i) }} onDrop={() => { if (stackDrag !== null && stackDrag !== i) reorder(stackDrag, i); setStackDrag(null); setOverIdx(null) }}
                style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${overIdx === i ? 'var(--orange)' : 'var(--divider)'}`, borderRadius: 8, padding: '8px 10px', background: stackDrag === i ? 'var(--bg3)' : '#fff', cursor: 'grab' }}>
                <GripVertical size={15} style={{ color: 'var(--ink3)' }} />
                <span style={{ color: 'var(--navy)' }}><CatIcon cat={a.category} size={15} /></span>
                <span style={{ flex: 1, fontWeight: 600, fontSize: 12.5 }}>{i + 1}. {a.name}</span>
                <button className="az-kebab" onClick={() => removeFromStack(a.id)} aria-label="Remove"><X size={14} /></button>
              </div>
            ))}
          </div>
          {stack.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
                <button className="az-btn dark" disabled={busy} onClick={() => void activate()}><Check size={15} />{busy ? 'Activating…' : `Activate strategy (${stack.length})`}</button>
                <button className="az-link" onClick={() => setStack([])}>Clear</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <input value={pbName} onChange={(e) => setPbName(e.target.value)} placeholder="Name this strategy…" style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', font: 'inherit', minWidth: 200 }} />
                <button className="az-btn" disabled={!pbName.trim()} onClick={() => { saveCustomPlaybook(pbName, stack); setPbName(''); setMsg('Saved as a playbook — find it in the Playbooks tab.') }}>Save as playbook</button>
              </div>
            </>
          )}
          {msg && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 10, fontWeight: 600 }}>{msg}</div>}
        </div>
      </div>
    </div>
  )
}
