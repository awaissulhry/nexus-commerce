'use client'

/**
 * RC6.2 — Library. Merges the old Library + Playbooks tabs into one surface:
 *   · Quick-start playbooks (one click adopts a whole strategy) at the top
 *   · the full 86-automation catalogue below, each with a plain-language
 *     "When → Then" explainer and behaviour-aware search.
 * Self-contained: owns its own search / category / sort / selection state and
 * loads custom playbooks itself; the hub just supplies the rule set + the add
 * handlers (which keep the audited disabled + dry-run contract).
 */

import { useEffect, useMemo, useState } from 'react'
import { Search, Plus, Sliders, Check, Trash2 } from 'lucide-react'
import { AUTOMATIONS, CATEGORIES, AUTOMATION_COUNT, type AutomationDef } from './automations'
import { PLAYBOOKS, playbookAutomations } from './playbooks'
import { loadCustomPlaybooks, deleteCustomPlaybook, type CustomPlaybook } from './customPlaybooks'
import { CatIcon, PlaybookIcon } from './_icons'
import { firesWhen, whatItChanges, searchBlob } from './explain'

const trgLabel = (t: string) => (t === 'SCHEDULE' ? 'SCHEDULED' : t.replace(/_/g, ' '))

interface LibraryTabProps {
  ruleNames: Set<string>
  busy: string | null
  onAdd: (def: AutomationDef) => void | Promise<void>
  onAddMany: (defs: AutomationDef[]) => void | Promise<void>
  onEnablePlaybook: (id: string) => void | Promise<void>
  onActivateCustom: (pb: CustomPlaybook) => void | Promise<void>
  onConfigure: (def: AutomationDef) => void
  onBuildCustom: () => void
  onGoActive: () => void
}

export function LibraryTab({ ruleNames, busy, onAdd, onAddMany, onEnablePlaybook, onActivateCustom, onConfigure, onBuildCustom, onGoActive }: LibraryTabProps) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('All')
  const [sortBy, setSortBy] = useState<'flagship' | 'name' | 'category'>('flagship')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [customPbs, setCustomPbs] = useState<CustomPlaybook[]>([])

  useEffect(() => { setCustomPbs(loadCustomPlaybooks()) }, [])

  // Pre-compute the search blob + "When/Then" mechanics once (buildRule per def).
  const BLOBS = useMemo(() => new Map(AUTOMATIONS.map((a) => [a.id, searchBlob(a)])), [])
  const MECH = useMemo(() => new Map(AUTOMATIONS.map((a) => [a.id, { when: firesWhen(a), does: whatItChanges(a) }])), [])
  const catCounts = useMemo(() => { const m: Record<string, number> = {}; for (const a of AUTOMATIONS) m[a.category] = (m[a.category] ?? 0) + 1; return m }, [])

  const ql = q.trim().toLowerCase()
  const filtered = useMemo(() => {
    const r = AUTOMATIONS.filter((a) => (cat === 'All' || a.category === cat) && (!ql || (BLOBS.get(a.id) ?? '').includes(ql)))
    return [...r].sort((a, b) =>
      sortBy === 'name' ? a.name.localeCompare(b.name)
        : sortBy === 'category' ? (a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
          : ((Number(!!b.marquee) - Number(!!a.marquee)) || a.name.localeCompare(b.name)))
  }, [cat, ql, sortBy, BLOBS])

  const toggleSel = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const selectAllShown = () => setSel(new Set(filtered.map((a) => a.id)))
  const addSelected = () => { const defs = [...sel].map((id) => AUTOMATIONS.find((a) => a.id === id)).filter((d): d is AutomationDef => !!d && !ruleNames.has(d.name)); void onAddMany(defs); setSel(new Set()) }

  // Playbooks: quick-start, only while browsing All; query filters them too.
  const pbMatch = (name: string, goal: string, desc: string) => !ql || `${name} ${goal} ${desc}`.toLowerCase().includes(ql)
  const shownPbs = cat === 'All' ? PLAYBOOKS.filter((pb) => pbMatch(pb.name, pb.goal, pb.desc)) : []
  const shownCustom = cat === 'All' ? customPbs.filter((pb) => pbMatch(pb.name, 'saved strategy', '')) : []
  const showQuickStart = shownPbs.length > 0 || shownCustom.length > 0

  return (
    <div className="az-lib">
      {/* ── Quick-start playbooks ─────────────────────────────────── */}
      {showQuickStart && (
        <section className="az-lib-sec">
          <div className="az-lib-sechd">
            <h3>Quick-start playbooks</h3>
            <span className="sub">Adopt a whole strategy in one click — each bundles several coordinated automations, all added <b>disabled + dry-run</b> so you can review before they run.</span>
          </div>
          <div className="az-pbrow">
            {shownPbs.map((pb) => {
              const autos = playbookAutomations(pb)
              const have = autos.filter((a) => ruleNames.has(a.name)).length
              const all = autos.length > 0 && have === autos.length
              return (
                <div key={pb.id} className="az-pbcard">
                  <div className="top"><span className="ic"><PlaybookIcon /></span><span className="nm">{pb.name}</span></div>
                  <div className="goal">{pb.goal} · {autos.length} automations</div>
                  <div className="d">{pb.desc}</div>
                  <div className="chips">{autos.map((a) => <span key={a.id} className={`chip ${ruleNames.has(a.name) ? 'on' : ''}`}>{a.name}</span>)}</div>
                  <div className="foot">
                    <span className="grow" />
                    {all
                      ? <button className="az-btn" onClick={onGoActive}><Check size={14} />Active ({have})</button>
                      : <button className="az-btn dark" disabled={busy === `pb:${pb.id}`} onClick={() => void onEnablePlaybook(pb.id)}>{busy === `pb:${pb.id}` ? 'Adding…' : have > 0 ? `Add ${autos.length - have} more` : 'Activate playbook'}</button>}
                  </div>
                </div>
              )
            })}
          </div>
          {shownCustom.length > 0 && <>
            <h4 className="az-lib-subhd">Your saved strategies</h4>
            <div className="az-pbrow">
              {shownCustom.map((pb) => {
                const autos = pb.automationIds.map((id) => AUTOMATIONS.find((a) => a.id === id)).filter((a): a is AutomationDef => !!a)
                const have = autos.filter((a) => ruleNames.has(a.name)).length
                const all = autos.length > 0 && have === autos.length
                return (
                  <div key={pb.id} className="az-pbcard">
                    <div className="top"><span className="ic"><PlaybookIcon /></span><span className="nm">{pb.name}</span><button className="az-kebab" onClick={() => setCustomPbs(deleteCustomPlaybook(pb.id))} title="Delete saved strategy" style={{ color: '#cc1100' }}><Trash2 size={14} /></button></div>
                    <div className="goal">Saved strategy · {autos.length} automations</div>
                    <div className="chips">{autos.map((a) => <span key={a.id} className={`chip ${ruleNames.has(a.name) ? 'on' : ''}`}>{a.name}</span>)}</div>
                    <div className="foot"><span className="grow" />{all ? <button className="az-btn" onClick={onGoActive}><Check size={14} />Active</button> : <button className="az-btn dark" disabled={busy === `cpb:${pb.id}`} onClick={() => void onActivateCustom(pb)}>{busy === `cpb:${pb.id}` ? 'Adding…' : 'Activate'}</button>}</div>
                  </div>
                )
              })}
            </div>
          </>}
        </section>
      )}

      {/* ── Full catalogue ────────────────────────────────────────── */}
      <section className="az-lib-sec">
        <div className="az-lib-sechd">
          <h3>All automations</h3>
          <span className="sub">{AUTOMATION_COUNT} distinct automations, each fully configurable. <b>Add</b> with smart defaults, or <b>Configure</b> to tune thresholds first — every one starts disabled + dry-run.</span>
        </div>

        <div className="az-lib-bar">
          <div className="az-search" style={{ minWidth: 280 }}><Search size={15} /><input placeholder="Search by name or what it does — e.g. “pause”, “budget”, “acos”…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <span className="cnt">{filtered.length} of {AUTOMATION_COUNT}</span>
          {filtered.length > 0 && <button className="az-link" onClick={selectAllShown}>Select all</button>}
          {sel.size > 0 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><b>{sel.size} selected</b><button className="az-btn dark" disabled={busy === 'bulk'} onClick={addSelected}>{busy === 'bulk' ? 'Adding…' : `Add ${sel.size}`}</button><button className="az-link" onClick={() => setSel(new Set())}>Clear</button></span>}
          <span className="grow" />
          <span className="ctl" style={{ cursor: 'default' }}>Sort
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as 'flagship' | 'name' | 'category')} style={{ marginLeft: 6, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 7px', font: 'inherit', cursor: 'pointer' }}>
              <option value="flagship">Flagship first</option><option value="name">Name (A–Z)</option><option value="category">Category</option>
            </select>
          </span>
          <button className="az-btn dark" onClick={onBuildCustom}><Plus size={15} />Build custom rule</button>
        </div>

        <div className="az-cats">{CATEGORIES.map((c) => <button key={c} className={`az-cat ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}{c !== 'All' && <span style={{ opacity: .55, marginLeft: 5 }}>{catCounts[c] ?? 0}</span>}</button>)}</div>

        {filtered.length === 0
          ? <div className="az-lib-empty">No automations match “<b>{q}</b>”{cat !== 'All' ? <> in <b>{cat}</b></> : null}. <button className="az-link" onClick={() => { setQ(''); setCat('All') }}>Clear filters</button> or <button className="az-link" onClick={onBuildCustom}>build a custom rule</button>.</div>
          : <div className="az-libgrid">
            {filtered.map((t) => {
              const added = ruleNames.has(t.name)
              const mech = MECH.get(t.id)
              return (
                <div key={t.id} className={`az-tmpl ${t.marquee ? 'marquee' : ''} ${sel.has(t.id) ? 'picked' : ''}`}>
                  <div className="top"><input type="checkbox" className="az-check" checked={sel.has(t.id)} onChange={() => toggleSel(t.id)} aria-label={`Select ${t.name}`} /><span className="ic"><CatIcon cat={t.category} /></span><span className="nm">{t.name}</span>{t.marquee && <span className="flag">Flagship</span>}</div>
                  <div className="cat">{t.category}</div>
                  <div className="d">{t.desc}</div>
                  {mech && (
                    <div className="az-mech">
                      <div className="row"><span className="lab">When</span><span className="val">{mech.when}</span></div>
                      <div className="row"><span className="lab">Then</span><span className="val">{mech.does.length ? mech.does.join(' · ') : 'notifies you'}</span></div>
                    </div>
                  )}
                  <div className="foot">
                    <span className="trg">{trgLabel(t.trigger)}</span>
                    <span className="grow" />
                    {added
                      ? <button className="az-btn" onClick={onGoActive}><Check size={14} />In rules</button>
                      : <><button className="az-btn" onClick={() => onConfigure(t)} title="Configure parameters"><Sliders size={13} />Configure</button><button className="az-btn dark" disabled={busy === t.id} onClick={() => void onAdd(t)}>{busy === t.id ? '…' : 'Add'}</button></>}
                  </div>
                </div>
              )
            })}
          </div>}

        <div className="az-lib-foot">Every automation is distinct and fully configurable — hit <b>Configure</b> to tune it, or <b>Add</b> with smart defaults (select several for a bulk add). All are added <b>disabled + dry-run</b>; turn them on from <button className="az-link" onClick={onGoActive}>Active rules</button>. Need something bespoke? <button className="az-link" onClick={onBuildCustom}>Build a custom rule</button>.</div>
      </section>
    </div>
  )
}
